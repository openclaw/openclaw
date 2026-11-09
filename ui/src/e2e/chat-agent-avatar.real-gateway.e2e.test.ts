import { spawnSync } from "node:child_process";
import { copyFile, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiDocument } from "../../../src/commands/control-ui-handoff.js";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.js";
import { setAvatar } from "../../../src/state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import {
  closeHttpServer,
  listenLoopback,
} from "../../../test/helpers/gateway-integration-fixtures.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:avatar-proof";
const reply = "My configured avatar appears beside this assistant reply.";
const rejectedStatuses = {
  "route-404": 404,
  "identity-404": 404,
  "credential-401": 401,
  "workspace-503": 503,
} as const;
type StreamCase = keyof typeof rejectedStatuses;
type ServerResponseProof = {
  id: string;
  caseName: StreamCase;
  status: number;
  credential: "stale" | "valid" | "other";
  finished: boolean;
  closed: boolean;
  endedAtClose: boolean | null;
  socketClosed: boolean;
};
type BrowserResponseProof = {
  id: string;
  fetchId: number;
  status: number;
  cancelCount: number;
  nativeCancelResolvedCount: number;
  cancelRejectedCount: number;
  blobReads: number;
  blobBytes: number;
};
type ProofWindow = typeof window & { avatarResponseProof: BrowserResponseProof[] };
type WorkspaceIconElement = HTMLElementTagNameMap["openclaw-workspace-icon"];

function resolveGatewayRuntime() {
  const bun = process.env.BUN_BIN;
  if (!bun) {
    return { gatewayCommandPrefix: undefined };
  }
  const probe = spawnSync(
    bun,
    [
      "--eval",
      "console.log(JSON.stringify({version:process.versions.bun,execPath:process.execPath}))",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(probe.status, probe.stderr).toBe(0);
  const runtime = JSON.parse(probe.stdout) as { version?: string; execPath?: string };
  if (!runtime.version || !runtime.execPath) {
    throw new Error("BUN_BIN must resolve to a Bun executable");
  }
  return {
    gatewayCommandPrefix: [runtime.execPath] satisfies [string],
  };
}

async function startAvatarStreams(origin: string, image: Buffer) {
  const responses: ServerResponseProof[] = [];
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Access-Control-Allow-Headers", "authorization");
    response.setHeader("Access-Control-Expose-Headers", "x-avatar-response-id,retry-after");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    const caseName = new URL(request.url ?? "/", origin).pathname.slice(1) as StreamCase;
    const rejectedStatus = rejectedStatuses[caseName];
    if (!rejectedStatus) {
      response.writeHead(404).end();
      return;
    }
    const authorization = request.headers.authorization;
    const credential =
      authorization === "Bearer avatar-proof-stale"
        ? "stale"
        : authorization === "Bearer avatar-proof-valid"
          ? "valid"
          : "other";
    const status =
      caseName.startsWith("credential-") && credential === "valid" ? 200 : rejectedStatus;
    const record: ServerResponseProof = {
      id: `${caseName}-${responses.length + 1}`,
      caseName,
      status,
      credential,
      finished: false,
      closed: false,
      endedAtClose: null,
      socketClosed: false,
    };
    responses.push(record);
    response.once("finish", () => {
      record.finished = true;
    });
    response.once("close", () => {
      record.closed = true;
      record.endedAtClose = response.writableEnded;
    });
    request.socket.once("close", () => {
      record.socketClosed = true;
    });
    response.writeHead(status, {
      "Content-Type": status === 200 ? "image/png" : "text/plain",
      "Cache-Control": "no-store",
      Connection: "close",
      "x-avatar-response-id": record.id,
      ...(status === 503 ? { "Retry-After": "1" } : {}),
    });
    if (status === 200) {
      response.end(image);
    } else {
      // Never end rejected responses: only browser cancellation or fixture teardown
      // can close them. Assertions run while the consumer and page remain mounted.
      response.write("avatar response remains pending");
    }
  });
  const url = await listenLoopback(server);
  return {
    url,
    responses,
    close: () => closeHttpServer(server),
  };
}

async function observeAvatarResponses(page: Page, pathname: string | RegExp) {
  await page.addInitScript(
    ({ path: observedPath, isRegex }) => {
      const proof: BrowserResponseProof[] = [];
      (window as ProofWindow).avatarResponseProof = proof;
      const originalFetch = window.fetch.bind(window);
      let fetchId = 0;
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          location.href,
        );
        if (
          !(isRegex ? new RegExp(observedPath).test(url.pathname) : url.pathname === observedPath)
        ) {
          return originalFetch(input, init);
        }
        const record: BrowserResponseProof = {
          id: "",
          fetchId: ++fetchId,
          status: 0,
          cancelCount: 0,
          nativeCancelResolvedCount: 0,
          cancelRejectedCount: 0,
          blobReads: 0,
          blobBytes: 0,
        };
        proof.push(record);
        const response = await originalFetch(input, init);
        record.id = response.headers.get("x-avatar-response-id") ?? "";
        record.status = response.status;
        if (!response.body) {
          return response;
        }
        const originalCancel = response.body.cancel.bind(response.body);
        response.body.cancel = async (reason) => {
          record.cancelCount += 1;
          await originalCancel(reason);
          record.nativeCancelResolvedCount += 1;
          // Reject only after native cancellation, so recovery must contain cleanup
          // failure without replacing the real Response or faking stream release.
          if (response.status === 401) {
            record.cancelRejectedCount += 1;
            throw new Error("avatar fixture cancellation rejection");
          }
        };
        const originalBlob = response.blob.bind(response);
        response.blob = async () => {
          record.blobReads += 1;
          const blob = await originalBlob();
          record.blobBytes = blob.size;
          return blob;
        };
        return response;
      };
    },
    {
      path: typeof pathname === "string" ? pathname : pathname.source,
      isRegex: typeof pathname !== "string",
    },
  );
}

let instance: OpenClawTestInstance | undefined;
let streams: Awaited<ReturnType<typeof startAvatarStreams>>;
const suite = createControlUiE2eSuite({
  name: "Control UI agent avatar with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const runtime = resolveGatewayRuntime();
    const owner = await createOpenClawTestInstance({
      name: "control-ui-agent-avatar",
      config: { gateway: { controlUi: { enabled: true } } },
      gatewayCommandPrefix: runtime.gatewayCommandPrefix,
    });
    instance = owner;
    try {
      const config = JSON.parse(await readFile(owner.configPath, "utf8"));
      await owner.state.writeConfig({
        ...config,
        agents: {
          defaults: {
            workspace: owner.state.workspaceDir,
            model: { primary: "openai/gpt-4.1" },
          },
          entries: {
            main: { identity: { name: "Avatar Proof", avatar: "agent-avatar.png" } },
          },
        },
      });
      const imagePath = path.join(process.cwd(), "ui/public/apple-touch-icon.png");
      const image = await readFile(imagePath);
      await copyFile(imagePath, path.join(owner.state.workspaceDir, "agent-avatar.png"));
      // Seed the browser owner so no host account name or photo enters the capture.
      const profile = ensureGatewayOwnerProfile("Chat Proof", { env: owner.env });
      expect(setAvatar(profile.id, image, "image/png", { env: owner.env }).ok).toBe(true);
      if (runtime.gatewayCommandPrefix) {
        // A source wrapper may respawn Node; Bun proof must launch the built entry directly.
        const entrypoint = await owner.entrypoint();
        expect(entrypoint).toHaveLength(1);
        expect(entrypoint[0]).toMatch(/^dist\/index\.m?js$/);
      }
      await owner.startGateway();
      if (runtime.gatewayCommandPrefix) {
        const pid = owner.child?.pid;
        if (!pid) {
          throw new Error("missing Gateway process for runtime proof");
        }
        // The custody view no longer exposes spawn metadata; inspect the live executable.
        const executable =
          process.platform === "linux"
            ? await realpath(`/proc/${pid}/exe`)
            : (await import("@openclaw/proc-safe/inspect")).readProcessCommand(pid)?.executable;
        expect(executable).toBe(await realpath(runtime.gatewayCommandPrefix[0]));
      }
      const created = await owner.cli([
        "gateway",
        "call",
        "sessions.create",
        "--params",
        JSON.stringify({ key: sessionKey, agentId: "main", label: "Agent avatar proof" }),
        "--json",
      ]);
      expect(created.code, created.stderr).toBe(0);
      const session = JSON.parse(created.stdout) as { ok: boolean; sessionId: string };
      expect(session.ok).toBe(true);
      for (const [role, text] of [
        ["user", "Show the configured agent identity in this conversation."],
        ["assistant", reply],
      ]) {
        await appendTranscriptMessage(
          { agentId: "main", sessionKey, sessionId: session.sessionId, env: owner.env },
          { message: { role, content: [{ type: "text", text }], timestamp: Date.now() } },
        );
      }
      const baseUrl = `http://127.0.0.1:${owner.port}/`;
      streams = await startAvatarStreams(new URL(baseUrl).origin, image);
      return {
        baseUrl,
        close: () =>
          runQaGatewayFixture(
            () => owner.cleanup(),
            () => streams.close(),
          ),
      };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});

async function openAvatarChat(page: Page) {
  if (!instance) {
    throw new Error("Gateway fixture is not running");
  }
  const document = await waitForControlUiDocument({
    url: `http://127.0.0.1:${instance.port}/`,
    timeoutMs: 60_000,
  });
  expect(document.ready, JSON.stringify(document)).toBe(true);
  // Each browser context consumes its own one-time dashboard handoff.
  const dashboard = await instance.cli(["dashboard", "--json"]);
  const handoff: { browserUrl: string; reason?: string } = JSON.parse(dashboard.stdout);
  expect(dashboard.code, handoff.reason ?? dashboard.stderr).toBe(0);
  const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
  url.hash = new URL(handoff.browserUrl).hash;
  expect((await page.goto(url.toString()))?.status()).toBe(404);
  await enterControlUiSession(page);
  await waitForControlUiGatewayReady(page);
  await page.getByText(reply, { exact: true }).waitFor();
}

async function routeAvatarStream(page: Page, caseName: StreamCase, pathname: string | RegExp) {
  await observeAvatarResponses(page, pathname);
  await page.route(
    (url) =>
      typeof pathname === "string" ? url.pathname === pathname : pathname.test(url.pathname),
    // continue() keeps Chromium's native stream; fulfill() would buffer it.
    (route) =>
      route.continue(
        route.request().resourceType() === "fetch"
          ? { url: `${streams.url}/${caseName}` }
          : undefined,
      ),
  );
}

async function openWorkspaceStream(page: Page, caseName: StreamCase) {
  const routeUrl = `/__openclaw__/workspace-icon/${caseName}`;
  await routeAvatarStream(page, caseName, routeUrl);
  await openAvatarChat(page);
}

async function mountWorkspaceIcon(
  page: Page,
  caseName: StreamCase,
  authTokens = ["avatar-proof-valid"],
) {
  await page.waitForFunction(() => Boolean(customElements.get("openclaw-workspace-icon")));
  await page.evaluate(
    async ({ routeUrl, authTokens: tokens }) => {
      const element = document.createElement("openclaw-workspace-icon");
      element.id = "avatar-stream-consumer";
      element.routeUrl = routeUrl;
      element.authTokens = tokens;
      element.authReady = true;
      const fixture = document.createElement("div");
      fixture.className = "chat-pane__workspace-chip";
      fixture.style.cssText = "position: fixed; bottom: 16px; right: 16px; z-index: 1000";
      fixture.append(element);
      document.body.append(fixture);
      await element.updateComplete;
    },
    { routeUrl: `/__openclaw__/workspace-icon/${caseName}`, authTokens },
  );
  return page.locator("#avatar-stream-consumer");
}

async function readBrowserResponses(page: Page) {
  return page.evaluate(() => (window as ProofWindow).avatarResponseProof);
}

function readServerResponses(caseName: StreamCase) {
  return streams.responses.filter((response) => response.caseName === caseName);
}

async function expectReleasedResponses(page: Page, caseName: StreamCase, count?: number) {
  const status = rejectedStatuses[caseName];
  await expect
    .poll(async () => {
      const allBrowser = await readBrowserResponses(page);
      const browser = allBrowser.filter((response) => response.status === status);
      const server = readServerResponses(caseName).filter((response) => response.status === status);
      return (
        (count === undefined ? server.length > 0 : server.length === count) &&
        allBrowser.every((response) => response.status !== 0) &&
        browser.length === server.length &&
        new Set(browser.map((response) => response.fetchId)).size === server.length &&
        server.every((response) => {
          const observed = browser.find((entry) => entry.id === response.id);
          return (
            observed?.status === response.status &&
            observed.cancelCount === 1 &&
            observed.nativeCancelResolvedCount === 1 &&
            observed.cancelRejectedCount === (status === 401 ? 1 : 0) &&
            observed.blobReads === 0 &&
            !response.finished &&
            response.closed &&
            response.endedAtClose === false &&
            response.socketClosed
          );
        })
      );
    })
    .toBe(true);
}

suite.define(() => {
  it("renders the configured workspace avatar beside a persisted assistant reply", async () => {
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" },
      async ({ page }) => {
        await openAvatarChat(page);
        const avatar = page.locator("img.chat-avatar.assistant");
        const decodedWidth = async () =>
          (await avatar.count()) === 1
            ? avatar.evaluate((element) => (element as HTMLImageElement).naturalWidth)
            : 0;
        await expect.poll(decodedWidth).toBeGreaterThan(0);
        expect(await avatar.getAttribute("src")).toMatch(/^blob:/);
        expect(await avatar.getAttribute("alt")).toBe("Avatar Proof");
        expect(await avatar.isVisible()).toBe(true);
        expect(
          await avatar.evaluate((element) => element.closest(".chat-group")?.textContent),
        ).toContain(reply);
      },
    );
  });

  it.each(["route-404", "workspace-503"] as const)(
    "releases %s without reminting its cached retry budget",
    async (caseName) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const retrying = caseName === "workspace-503";
        if (retrying) {
          await page.clock.install();
        }
        await openWorkspaceStream(page, caseName);
        if (retrying) {
          // Park before mount so network latency cannot spend the retry budget.
          await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
        }
        const consumer = await mountWorkspaceIcon(page, caseName);
        const attempts = retrying ? 4 : 1;
        for (let count = 1; count <= attempts; count += 1) {
          if (count > 1) {
            await page.clock.runFor(1_000);
          }
          await expectReleasedResponses(page, caseName, count);
        }
        expect(await consumer.locator(".workspace-icon-fallback").isVisible()).toBe(true);
        if (retrying) {
          await page.clock.runFor(29_000);
        }
        await consumer.evaluate(async (element: WorkspaceIconElement) => {
          element.authTokens = [...element.authTokens];
          await element.updateComplete;
        });
        await expectReleasedResponses(page, caseName, attempts);
        expect(readServerResponses(caseName)).toHaveLength(attempts);
        expect(await readBrowserResponses(page)).toHaveLength(attempts);
        expect(await consumer.locator(".workspace-icon-fallback").isVisible()).toBe(true);
        expect(await consumer.locator("img").count()).toBe(0);
        expect(await consumer.evaluate((element) => element.isConnected)).toBe(true);
        if (!retrying) {
          await consumer.evaluate((element) => element.remove());
        }
      });
    },
  );

  it("releases a pending identity-context 404 while the persisted reply keeps its fallback", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await routeAvatarStream(page, "identity-404", /^\/avatar\/main(?:\/|$)/);
      await openAvatarChat(page);
      await expectReleasedResponses(page, "identity-404");
      const group = page
        .locator(".chat-group")
        .filter({ has: page.getByText(reply, { exact: true }) });
      await expect
        .poll(async () => ({
          fallback: await group
            .locator(".identity-avatar--agent.chat-avatar.assistant .identity-avatar__fallback")
            .isVisible(),
          sourcedImages: await group.locator("img.chat-avatar.assistant[src]").count(),
        }))
        .toEqual({ fallback: true, sourcedImages: 0 });
      expect(await group.evaluate((element) => element.isConnected)).toBe(true);
    });
  });

  it("recovers from a pending 401 and rejected cancellation without canceling the valid avatar", async () => {
    const status = 401;
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const caseName = `credential-${status}` as const;
      await openWorkspaceStream(page, caseName);
      const consumer = await mountWorkspaceIcon(page, caseName, [
        "avatar-proof-stale",
        "avatar-proof-valid",
      ]);
      await expectReleasedResponses(page, caseName, 1);
      const image = consumer.locator("img.workspace-icon");
      await image.waitFor();
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);
      expect(await image.getAttribute("src")).toMatch(/^blob:/);
      expect(await image.isVisible()).toBe(true);
      const browser = await readBrowserResponses(page);
      expect(browser).toMatchObject([{ status }, { status: 200, cancelCount: 0, blobReads: 1 }]);
      const success = browser[1];
      expect(success?.blobBytes).toBeGreaterThan(0);
      expect(readServerResponses(caseName)).toMatchObject([
        { status, credential: "stale" },
        { id: success?.id, status: 200, credential: "valid", finished: true, endedAtClose: true },
      ]);
    });
  });
});
