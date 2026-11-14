import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-contract.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiTerminalReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  createControlUiMockBootstrapConfig,
  captureControlUiE2eFailureDiagnostics,
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  refreshProductionControlUiE2e,
  startProductionControlUiE2eServer,
  startCopiedProductionControlUiE2eServer,
  type ControlUiE2eProductionServer,
} from "../test-helpers/control-ui-e2e.ts";

const useWebKit = process.env.OPENCLAW_CONTROL_UI_E2E_BROWSER === "webkit";
const {
  executablePath: chromiumExecutablePath,
  available: chromiumAvailable,
  wsEndpoint: chromiumWsEndpoint,
} = inject("controlUiE2eChromium");
let artifactDir: string;
beforeEach(() => {
  if (captureUiProof) {
    artifactDir = createControlUiE2eArtifactDir("service-worker-update");
  }
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const buildA = "service-worker-build-a";
const buildB = "service-worker-build-b";

type BuildAsset = {
  path: string;
  sha256: string;
};

type InstallGate = {
  url: string;
  requested: Promise<void>;
  release: () => void;
  close: () => Promise<void>;
};

let browser: Browser;
let outDir: string;
let server: ControlUiE2eProductionServer;

async function stageBuildB(destination: string): Promise<void> {
  await rm(destination, { force: true, recursive: true });
  try {
    // Rollback preserves build B for the next case; only the terminal case modifies its worker.
    await cp(outDir, destination, { recursive: true, dereference: true });
    await refreshProductionControlUiE2e(destination, buildB);
  } catch (error) {
    await rm(destination, { force: true, recursive: true });
    throw error;
  }
}

async function findBuildAsset(buildId: string, buildDir = outDir): Promise<BuildAsset> {
  const html = await readFile(path.join(buildDir, "index.html"), "utf8");
  expect(html).toContain(`"buildId":${JSON.stringify(buildId)}`);
  const assetPath = html.match(/<script\b[^>]*\bsrc="\.\/(assets\/[^"?]+\.js)"/u)?.[1];
  if (!assetPath) {
    throw new Error(`Production Control UI output has no entry script for ${buildId}`);
  }
  const source = await readFile(path.join(buildDir, assetPath));
  return {
    path: assetPath,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}

async function readBuildCacheName(buildId: string, buildDir = outDir): Promise<string> {
  const worker = await readFile(path.join(buildDir, "sw.js"), "utf8");
  const embeddedBuild = /^const EMBEDDED_CACHE_VERSION = (.+);$/mu.exec(worker)?.[1];
  const offlineBoot = /^const OFFLINE_BOOT = (.+);$/mu.exec(worker)?.[1];
  if (!embeddedBuild || !offlineBoot || JSON.parse(embeddedBuild) !== buildId) {
    throw new Error(`Staged service worker does not belong to build ${buildId}`);
  }
  const manifest: unknown = JSON.parse(offlineBoot);
  if (
    !isRecord(manifest) ||
    typeof manifest.id !== "string" ||
    !/^[a-f0-9]{16}$/u.test(manifest.id)
  ) {
    throw new Error(`Staged service worker has no offline boot digest for ${buildId}`);
  }
  // The same build ID can name different boot graphs; never infer this from an arbitrary cache.
  return `openclaw-control-${buildId}-${manifest.id}`;
}

async function prepareOnlineLoopback(page: Page): Promise<void> {
  // Upgrade scenarios need the boot cache, not unrelated deferred offline downloads.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: Object.assign(new EventTarget(), { saveData: true, effectiveType: "4g" }),
    });
  });
  // Network-isolated runners have no external interface, although this fixture
  // serves HTTP on loopback. Set the browser network state before any navigation.
  if (!useWebKit) {
    const protocol = await page.context().newCDPSession(page);
    // Chromium clears an all-unthrottled state override. A positive latency
    // hint keeps the native online override active; this command does not throttle requests.
    await protocol.send("Network.overrideNetworkState", {
      offline: false,
      latency: 1,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "ethernet",
    });
  }
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
}

async function createInstallGate(): Promise<InstallGate> {
  let released = false;
  const pendingResponses = new Set<ServerResponse>();
  const releaseResponse = (response: ServerResponse) => {
    if (!response.writableEnded) {
      response.statusCode = 204;
      response.end();
    }
  };
  const release = () => {
    released = true;
    for (const response of pendingResponses) {
      releaseResponse(response);
    }
    pendingResponses.clear();
  };
  let resolveRequested = () => {};
  const requested = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });
  const gateServer = createHttpServer((_request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    // Worker installation may retry or overlap; release is permanent for this gate.
    if (released) {
      releaseResponse(response);
    } else {
      pendingResponses.add(response);
      response.once("close", () => pendingResponses.delete(response));
    }
    resolveRequested();
  });
  await new Promise<void>((resolve, reject) => {
    gateServer.once("error", reject);
    gateServer.listen(0, "127.0.0.1", () => {
      gateServer.off("error", reject);
      resolve();
    });
  });
  const address = gateServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Install gate did not expose a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/release-install`,
    requested,
    release,
    close: async () => {
      release();
      await new Promise<void>((resolve, reject) => {
        gateServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function holdReplacementWorkerInstalling(buildDir: string, gateUrl: string): Promise<void> {
  const workerPath = path.join(buildDir, "sw.js");
  const source = await readFile(workerPath, "utf8");
  const install = "event.waitUntil(prepareOfflineShell().then(() => self.skipWaiting()));";
  if (source.split(install).length !== 2) {
    throw new Error("Production service worker did not contain the expected install lifetime");
  }
  await writeFile(
    workerPath,
    source.replace(
      install,
      `event.waitUntil(Promise.all([prepareOfflineShell(), fetch(${JSON.stringify(gateUrl)})]).then(() => self.skipWaiting()));`,
    ),
  );
}

async function ensureControlledPage(page: Page, pageErrors: string[], expectedBuildId: string) {
  const registration = await page.evaluate(async (workerBuildId) => {
    const ready = navigator.serviceWorker.ready.then((value) => ({
      activeState: value.active?.state ?? null,
      controlled: navigator.serviceWorker.controller !== null,
      error: null,
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ activeState: null; controlled: boolean; error: string }>(
      (resolve) => {
        // Diagnostics must not await a worker API or fetch before settling the
        // deadline; either can be the unavailable resource being diagnosed.
        timer = setTimeout(
          () =>
            resolve({
              activeState: null,
              controlled: navigator.serviceWorker.controller !== null,
              error: "Worker readiness timed out for " + workerBuildId,
            }),
          10_000,
        );
      },
    );
    try {
      return await Promise.race([ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }, expectedBuildId);
  if (registration.error) {
    throw new Error(
      `Service worker did not become ready: ${registration.error}; page errors: ${JSON.stringify(pageErrors)}`,
    );
  }
  await page.waitForFunction(async () => {
    const value = await navigator.serviceWorker.ready;
    return value.active?.state === "activated";
  });
  if (!registration.controlled) {
    // Reload once so the freshly activated worker controls the page. The
    // reload may land on a router deep link like /chat/research; the preview
    // server mirrors the Gateway's depth-insensitive /assets/ resolution, so
    // that boots correctly. (A racy replaceState("/") used to canonicalize
    // the URL here and could interleave with the router's own redirect.)
    await page.reload();
  }
  await page.waitForFunction(() => navigator.serviceWorker?.controller?.state === "activated");
  // Finish startup's update check before a later build replaces the served files.
  // Concurrent native update calls can otherwise share the old build's response.
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.ready).update();
  });
}

async function waitForActiveWorkerBuild(page: Page, expectedBuildId: string): Promise<void> {
  // Offline storage is optional. Read activation identity through the same native
  // protocol as foreground recovery, without delivering the missed page events.
  await page.waitForFunction(async (buildId) => {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = registration?.active;
    if (
      !registration ||
      !worker ||
      worker.state !== "activated" ||
      registration.installing ||
      navigator.serviceWorker.controller !== worker
    ) {
      return false;
    }
    const channel = new MessageChannel();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const message = await new Promise<{ type?: string; version?: string } | null>((resolve) => {
        // Match the runtime probe's unavailable-worker bound and release its ports.
        timeout = setTimeout(() => resolve(null), 1_000);
        channel.port1.addEventListener("message", (event) => resolve(event.data), { once: true });
        channel.port1.start();
        worker.postMessage({ type: "sw-version-probe" }, [channel.port2]);
      });
      return (
        registration.active === worker &&
        navigator.serviceWorker.controller === worker &&
        worker.state === "activated" &&
        !registration.installing &&
        message?.type === "sw-updated" &&
        message.version === buildId
      );
    } finally {
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
    }
  }, expectedBuildId);
}

async function fetchControlledAsset(
  page: Page,
  assetPath: string,
): Promise<{ controllerState: string | null; sha256: string }> {
  return page.evaluate(async (relativePath) => {
    const response = await fetch(new URL(`/${relativePath}`, window.location.origin));
    if (!response.ok) {
      throw new Error(`Build asset request failed with HTTP ${response.status}`);
    }
    const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
    await new Promise<void>((resolve) => {
      let observedController: ServiceWorker | null = null;
      const observeController = () => {
        const controller = navigator.serviceWorker.controller;
        if (controller !== observedController) {
          observedController?.removeEventListener("statechange", observeController);
          observedController = controller;
          observedController?.addEventListener("statechange", observeController);
        }
        if (controller?.state !== "activated") {
          return;
        }
        observedController?.removeEventListener("statechange", observeController);
        navigator.serviceWorker.removeEventListener("controllerchange", observeController);
        resolve();
      };
      navigator.serviceWorker.addEventListener("controllerchange", observeController);
      observeController();
    });
    return {
      controllerState: navigator.serviceWorker.controller?.state ?? null,
      sha256: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  }, assetPath);
}

describe("Control UI service-worker production update E2E", () => {
  beforeAll(async () => {
    if (!useWebKit && !chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    outDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-service-worker-update-"));
    const bootstrap = createControlUiMockBootstrapConfig({
      assistantAgentId: "research",
      defaultAgentId: "research",
      serverBuildId: buildA,
      terminalEnabled: true,
    });
    const prebuilt = inject("controlUiE2ePrebuiltAssets");
    server = prebuilt
      ? await startCopiedProductionControlUiE2eServer(prebuilt.root, outDir, buildA, bootstrap)
      : await startProductionControlUiE2eServer(outDir, buildA, bootstrap);
    await stageBuildB(`${outDir}-next`);
    browser = useWebKit
      ? await webkit.launch()
      : chromiumWsEndpoint
        ? await chromium.connect(chromiumWsEndpoint, { timeout: 30_000 })
        : await chromium.launch({ executablePath: chromiumExecutablePath });
  }, 180_000);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        if (outDir) {
          await Promise.all(
            ["", "-next", "-previous", "-sleeping"].map((suffix) =>
              rm(`${outDir}${suffix}`, { force: true, recursive: true }),
            ),
          );
        }
      }
    }
  });

  it.each(["chat", "config"] as const)(
    "recovers a missed worker activation without losing a %s draft",
    async (mode) => {
      const context = await browser.newContext({ serviceWorkers: "allow" });
      const page = await context.newPage();
      await prepareOnlineLoopback(page);
      page.setDefaultTimeout(15_000);
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.addInitScript(() => {
        // Model missing one-shot notifications, not fake worker activation or reload.
        for (const type of ["message", "controllerchange"]) {
          navigator.serviceWorker.addEventListener(type, (event) => {
            if (sessionStorage.getItem("test-missed-activation") === "1") {
              event.stopImmediatePropagation();
            }
          });
        }
      });
      const gateway = await installMockGateway(page, {
        assistantAgentId: "research",
        defaultAgentId: "research",
        serverBuildId: buildA,
        terminalEnabled: true,
        methodResponses: {
          "config.get": {
            config: { count: 1 },
            raw: '{ "count": 1 }',
            hash: "config-a",
            valid: true,
            issues: [],
          },
          "config.schema": {
            schema: { type: "object", properties: { count: { type: "number" } } },
            uiHints: {},
            version: "test",
            generatedAt: "2026-09-06T00:00:00.000Z",
          },
        },
      });
      await page.unroute("**" + CONTROL_UI_BOOTSTRAP_CONFIG_PATH);
      const resume = () =>
        page.evaluate(() => {
          sessionStorage.removeItem("test-missed-activation");
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "visible",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
      const nextDir = outDir + "-next";
      const previousDir = outDir + "-sleeping";
      let swapped = false;
      try {
        await page.goto(
          server.baseUrl + (mode === "chat" ? "chat" : "settings/advanced") + "?resume=1#latest",
        );
        await ensureControlledPage(page, pageErrors, buildA);
        if (mode === "chat") {
          await gateway.waitForRequest("sessions.messages.subscribe");
        } else {
          await page.getByRole("button", { name: "Raw", exact: true }).click();
        }
        const originalUrl = page.url();
        const editor = page.locator(
          mode === "chat"
            ? ".agent-chat__composer-combobox textarea"
            : ".config-raw-field textarea",
        );
        const draft =
          mode === "chat" ? "keep my draft through the missed update" : '{ "count": 2 }';
        await editor.fill(draft);
        await page.evaluate(() => sessionStorage.setItem("test-missed-activation", "1"));
        await server.replaceBuild(nextDir, previousDir);
        swapped = true;
        await page.evaluate(async () => {
          await (await navigator.serviceWorker.getRegistration())?.update();
        });
        await waitForActiveWorkerBuild(page, buildB);
        expect((await gateway.getRequests("connect")).at(-1)?.params).toMatchObject({
          client: { buildId: buildA },
        });
        await gateway.setServerBuildId(buildB);
        if (mode === "config") {
          await resume();
          // The native message round trip must not navigate a dirty settings page.
          await page.waitForTimeout(300);
          expect(await editor.inputValue()).toBe(draft);
          expect((await gateway.getRequests("connect")).at(-1)?.params).toMatchObject({
            client: { buildId: buildA },
          });
        }
        const reloaded = page.waitForEvent("domcontentloaded");
        if (mode === "config") {
          await page.getByRole("button", { name: "Discard", exact: true }).click();
        }
        try {
          await resume();
        } catch (error) {
          // Discard can let the first foreground check reload before this trigger returns.
          if (
            mode !== "config" ||
            !(error instanceof Error) ||
            !error.message.includes(
              "Execution context was destroyed, most likely because of a navigation",
            )
          ) {
            throw error;
          }
        }
        await reloaded;
        await expect
          .poll(async () => (await gateway.getRequests("connect")).at(-1)?.params)
          .toMatchObject({ client: { buildId: buildB } });
        expect(page.url()).toBe(originalUrl);
        if (mode === "chat") {
          await expect.poll(() => editor.inputValue()).toBe(draft);
        } else {
          await page.getByRole("button", { name: "Raw", exact: true }).click();
          await expect
            .poll(async () => JSON.parse(await editor.inputValue()))
            .toEqual({ count: 1 });
        }
      } catch (error) {
        if (error instanceof Error) {
          await captureControlUiE2eFailureDiagnostics(page, {
            error,
            label: "worker-missed-activation",
            pageErrors,
          });
        }
        throw error;
      } finally {
        await context.close();
        if (swapped) {
          await server.replaceBuild(previousDir, nextDir);
        }
      }
    },
    120_000,
  );

  it("refreshes a same-version build on reconnect before restoring an owned terminal", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "allow",
      viewport: { height: 720, width: 1280 },
      ...(captureUiProof
        ? { recordVideo: { dir: artifactDir, size: { height: 720, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(`${error.name}:${error.message}`));
    const gateway = await installMockGateway(page, {
      assistantAgentId: "research",
      defaultAgentId: "research",
      serverBuildId: buildA,
      serverVersion: "2026.7.10",
      featureMethods: ["terminal.open", "terminal.attach"],
      methodResponses: {
        "terminal.attach": {
          agentId: "research",
          confined: false,
          cwd: "/workspace/research",
          sessionId: "terminal-after-worker-refresh",
          shell: "/bin/bash",
          buffer: "restored terminal output",
          seq: 24,
          owner: "agent:research:main",
        },
      },
      terminalEnabled: true,
    });
    await prepareOnlineLoopback(page);
    const getTerminalAttaches = () => gateway.getRequests("terminal.attach");
    let installGate: InstallGate | null = null;

    try {
      expect((await page.goto(`${server.baseUrl}chat`))?.status()).toBe(200);
      await ensureControlledPage(page, pageErrors, buildA);
      await expect
        .poll(
          async () =>
            evaluateControlUiContext(page, (application) => {
              return {
                phase: application.gateway.snapshot.phase,
                terminalEnabled: application.config.current.terminalEnabled,
                hasHello: application.gateway.snapshot.hello !== null,
              };
            }),
          { timeout: controlUiE2eWaitTimeoutMs },
        )
        .toMatchObject({
          phase: "connected",
          terminalEnabled: true,
          hasHello: true,
        });
      await waitForControlUiTerminalReady(page);

      const assetA = await findBuildAsset(buildA);
      const cacheA = await readBuildCacheName(buildA);
      const initialAsset = await fetchControlledAsset(page, assetA.path);
      expect(initialAsset).toEqual({
        controllerState: "activated",
        sha256: assetA.sha256,
      });
      await expect.poll(() => page.evaluate(() => caches.keys())).toContain(cacheA);

      const nextOutDir = `${outDir}-next`;
      const previousOutDir = `${outDir}-previous`;
      installGate = await createInstallGate();
      await holdReplacementWorkerInstalling(nextOutDir, installGate.url);
      const cacheB = await readBuildCacheName(buildB, nextOutDir);
      const assetB = await findBuildAsset(buildB, nextOutDir);
      expect(assetB).toEqual(assetA);

      await gateway.setOnline(false);
      await expect
        .poll(
          () => evaluateControlUiContext(page, (application) => application.gateway.snapshot.phase),
          { timeout: controlUiE2eWaitTimeoutMs },
        )
        .not.toBe("connected");
      await server.replaceBuild(nextOutDir, previousOutDir);
      await rm(previousOutDir, { force: true, recursive: true });
      // Assets and Gateway identity advance together in a deployment. Publish
      // build B before a stale lazy chunk can reload and reconnect the document.
      await gateway.setServerBuildId(buildB);
      // The production preview serves static files directly instead of applying
      // the Gateway's deep-link canonicalization before returning index.html.
      await page.evaluate(() => window.history.replaceState(window.history.state, "", "/"));
      const reloaded = page.waitForEvent("domcontentloaded");
      await gateway.setOnline(true);
      await installGate.requested;
      await page.waitForFunction(async () => {
        const registration = await navigator.serviceWorker.getRegistration();
        return registration?.installing?.state === "installing";
      });
      await waitForControlUiGatewayReady(page);
      await waitForControlUiTerminalReady(page);
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("openclaw:terminal-toggle", {
            detail: {
              open: true,
              terminalSessionId: "terminal-after-worker-refresh",
            },
          }),
        );
      });
      await expect
        .poll(() => page.evaluate(() => sessionStorage.getItem("openclaw.terminal.actions.v1")))
        .toContain("terminal-after-worker-refresh");
      await page.waitForTimeout(300);
      const attachesBeforeWorkerActivation = await getTerminalAttaches();
      expect(attachesBeforeWorkerActivation.length).toBeLessThanOrEqual(1);
      if (attachesBeforeWorkerActivation.length > 0) {
        const currentConnect = (await gateway.getRequests("connect")).at(-1);
        expect(currentConnect?.params).toMatchObject({ client: { buildId: buildB } });
      }
      installGate.release();
      await reloaded;
      await ensureControlledPage(page, pageErrors, buildB);
      await expect
        .poll(async () => (await gateway.getRequests("connect")).at(-1)?.params)
        .toMatchObject({ client: { buildId: buildB } });

      const terminal = page.locator("openclaw-terminal-panel[embedded]");
      await terminal.waitFor({ state: "attached" });
      await expect
        .poll(() =>
          terminal.evaluate((element) => {
            const panel = element as HTMLElement & {
              agentId: string | null;
              available: boolean;
              terminalPanelOpen: boolean;
            };
            return {
              agentId: panel.agentId,
              available: panel.available,
              open: panel.terminalPanelOpen,
            };
          }),
        )
        .toEqual({ agentId: "research", available: true, open: true });
      // Panel visibility precedes asynchronous terminal boot and RPC dispatch.
      // Observe the request and finish its intent before counting exactly once.
      await expect.poll(getTerminalAttaches).toHaveLength(1);
      await expect
        .poll(() => page.evaluate(() => sessionStorage.getItem("openclaw.terminal.actions.v1")))
        .toBeNull();
      const terminalAttaches = await getTerminalAttaches();
      expect(terminalAttaches).toHaveLength(1);
      expect(terminalAttaches[0]?.params).toEqual({
        sessionId: "terminal-after-worker-refresh",
      });

      await expect.poll(() => page.evaluate(() => caches.keys())).toContain(cacheB);
      const refreshedAsset = await fetchControlledAsset(page, assetB.path);
      expect(refreshedAsset).toMatchObject({
        controllerState: "activated",
        sha256: assetB.sha256,
      });
      expect(refreshedAsset.sha256).toBe(initialAsset.sha256);
      await expect
        .poll(() =>
          page.evaluate(
            async ({ assetPath, currentBuildId, previousBuildId, cacheName }) => {
              const registration = await navigator.serviceWorker.getRegistration();
              if (!registration) {
                return null;
              }
              const shell = await caches.match(new URL("__offline_shell__", registration.scope), {
                cacheName,
              });
              const html = shell ? await shell.text() : "";
              return {
                currentAsset: html.includes(assetPath),
                currentBuild: html.includes(`"buildId":${JSON.stringify(currentBuildId)}`),
                previousBuild: html.includes(`"buildId":${JSON.stringify(previousBuildId)}`),
                documentRootCached: Boolean(
                  await caches.match(new URL("./", registration.scope), { cacheName }),
                ),
              };
            },
            {
              assetPath: assetB.path,
              currentBuildId: buildB,
              previousBuildId: buildA,
              cacheName: cacheB,
            },
          ),
        )
        .toEqual({
          currentAsset: true,
          currentBuild: true,
          previousBuild: false,
          documentRootCached: false,
        });

      if (captureUiProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "updated-worker-controlled-page.png"),
        });
      }
    } catch (error) {
      // Boot/readiness stalls otherwise fail as all-null poll snapshots with
      // no CI evidence; capture page state before the context closes.
      if (error instanceof Error) {
        await captureControlUiE2eFailureDiagnostics(page, {
          error,
          label: "service-worker-update-reconnect",
          pageErrors,
        });
      }
      throw error;
    } finally {
      await installGate?.close();
      await context.close();
    }
  }, 120_000);
});
