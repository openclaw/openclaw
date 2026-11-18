import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type APIResponse, type Browser, type Page, type Request } from "playwright";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../src/config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../../src/config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "../../../src/gateway/auth.js";
import * as documentTransport from "../../../src/gateway/control-ui-static.js";
import { createGatewayHttpServer } from "../../../src/gateway/server-http.js";
import { createGatewayRequestContext } from "../../../src/gateway/server-request-context.js";
import { makeContextParams } from "../../../src/gateway/server-request-context.test-support.js";
import { bindSessionRowProjection } from "../../../src/gateway/session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../../../src/gateway/session-row-projection.js";
import { sessionChanges } from "../../../src/sessions/session-row-changes.js";
import {
  createAgentDatabaseInspectionRefusal,
  publishPendingAgentDatabaseReadAdmission,
  readAgentDatabaseAdmissionRefusal,
  readAgentDatabaseReadAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../../src/state/agent-database-admission.js";
import { createAgentDatabaseStartupObservation } from "../../../src/state/agent-database-startup-observation.js";
import type { PendingAgentDatabaseRecovery } from "../../../src/state/agent-database-startup.types.js";
import { resolveOpenClawAgentSqlitePath } from "../../../src/state/openclaw-agent-db.paths.js";
import { ensureCanonicalUserProfileForEmail } from "../../../src/state/user-profile-writes.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  buildProductionControlUiE2e,
  captureControlUiE2eFailureDiagnostics,
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  refreshProductionControlUiE2e,
  resolvePlaywrightChromiumExecutablePath,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";

const buildA = "session-entry-build-a";
const buildB = "session-entry-build-b";
const publicPath = "/chat/main/dashboard/12345678-aaaa-4000-8000-000000000001";
const publicScope = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:12345678-aaaa-4000-8000-000000000001",
  sessionId: "public-browser-instance",
};
const unrelatedScope = {
  agentId: "main",
  sessionKey: "agent:main:unrelated-publication",
  sessionId: "unrelated-browser-instance",
};
const publishedMessage = "Synthetic published conversation.";
const operatorEmail = "reload-operator@example.test";
const trustedProxy = { userHeader: "x-forwarded-user", allowLoopback: true };
type HttpSample = { path: string; status: number };

// Real HTTP authentication, session publication, HTML delivery and built workers;
// only the unrelated WS services use the existing deterministic UI fixture.
describe("public-session post-deploy app handoff", () => {
  let browser: Browser | undefined;
  let fixture: string | undefined;
  let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
  let projection: SessionRowProjection | undefined;
  let listener: Awaited<ReturnType<typeof reserveTestPortListener<Server>>> | undefined;
  let baseUrl: string;
  let root: { kind: "resolved"; path: string };
  let cfg: OpenClawConfig;
  let auth: ResolvedGatewayAuth;
  let gatewayContext: ReturnType<typeof createGatewayRequestContext>;
  const requests: HttpSample[] = [];
  let publication = 2;

  beforeAll(async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), "openclaw-post-deploy-entry-"));
    const sharedBuildRoot = inject("controlUiE2eBuildRoot");
    if (sharedBuildRoot) {
      await cp(sharedBuildRoot, path.join(fixture, buildA), { recursive: true });
      await refreshProductionControlUiE2e(path.join(fixture, buildA), buildA);
    } else {
      // Focused runs without a bundled consumer have no invocation-wide build.
      await buildProductionControlUiE2e(path.join(fixture, buildA), buildA);
    }
    // Release identity lives in HTML and the worker; both builds use the same compiled source.
    await cp(path.join(fixture, buildA), path.join(fixture, buildB), { recursive: true });
    await refreshProductionControlUiE2e(path.join(fixture, buildB), buildB);
    state = await createOpenClawTestState({
      scenario: "minimal",
      label: "post-deploy-session-entry",
    });
    cfg = {
      agents: { entries: { main: {} } },
      gateway: {
        publicOrigin: "https://threads.example.test",
        auth: { mode: "trusted-proxy", trustedProxy },
        trustedProxies: ["127.0.0.1"],
        controlUi: { root: path.join(fixture, buildA) },
        cliAgents: { enabled: false },
        roles: {
          default: "reader",
          definitions: {
            reader: { agents: "*", sessions: { others: "view" }, scopes: ["operator.read"] },
          },
        },
      },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg, cfg);
    const owner = await ensureCanonicalUserProfileForEmail(operatorEmail);
    await upsertSessionEntryCore(publicScope, {
      sessionId: publicScope.sessionId,
      updatedAt: 1,
      displayName: "Synthetic public session",
      createdActor: { type: "human", source: "profile", id: owner.id },
      publicShare: { id: "a".repeat(48), sessionId: publicScope.sessionId, createdAt: 1 },
    });
    await replaceTranscriptEvents(publicScope, [
      { type: "session", version: 3, id: publicScope.sessionId },
      {
        type: "message",
        id: "published-message",
        message: { role: "user", content: publishedMessage },
      },
    ]);
    await upsertSessionEntryCore(unrelatedScope, {
      sessionId: unrelatedScope.sessionId,
      updatedAt: 2,
    });
    projection = await createSessionRowProjection({ cfg, getConfig: () => cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    gatewayContext = createGatewayRequestContext(makeContextParams());
    gatewayContext.resolveGatewayContext = () => gatewayContext;
    bindSessionRowProjection(gatewayContext, () => projection);
    root = { kind: "resolved", path: path.join(fixture, buildA) };
    auth = { mode: "trusted-proxy", trustedProxy, allowTailscale: false };
    listener = await reserveTestPortListener({
      offsets: [0],
      createListener: () => {
        const server = createGatewayHttpServer({
          clients: new Set(),
          controlUiEnabled: true,
          controlUiBasePath: "",
          controlUiRoot: root,
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth: auth,
          getResolvedAuth: () => auth,
          getRuntimeConfig: () => cfg,
          getGatewayRequestContext: () => gatewayContext,
          httpRequestLifetime: gatewayContext,
          isTerminalEnabled: () => false,
        });
        server.prependListener("request", (req, res) => {
          // Model Access: canonical links bypass login; the protected handoff
          // receives identity only from an authenticated synthetic proxy session.
          req.headers.host = "threads.example.test";
          req.headers["x-forwarded-for"] = "203.0.113.42";
          req.headers["x-forwarded-proto"] = "https";
          req.headers["x-openclaw-scopes"] = "operator.read";
          delete req.headers["x-forwarded-user"];
          if (!req.url?.startsWith("/chat/") && req.headers.cookie?.includes("operator=1")) {
            req.headers["x-forwarded-user"] = operatorEmail;
          }
          const requestPath = req.url ?? "/";
          res.once("finish", () => requests.push({ path: requestPath, status: res.statusCode }));
        });
        return server;
      },
    });
    baseUrl = `http://127.0.0.1:${listener.claim.port}`;
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
  }, 180_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      await browser?.close();
    } finally {
      try {
        listener?.listener.closeAllConnections();
        await listener?.releaseListener();
        await listener?.claim.release();
      } finally {
        projection?.dispose();
        await state?.cleanup();
        if (fixture) {
          await rm(fixture, { force: true, recursive: true });
        }
      }
    }
  });

  function holdAppDelivery() {
    const entered = createDeferred();
    const resume = createDeferred();
    const delivered = createDeferred<number>();
    const send = documentTransport.sendControlUiHtmlBody;
    const spy = vi
      .spyOn(documentTransport, "sendControlUiHtmlBody")
      .mockImplementationOnce(async (...args) => {
        const [, res, body, isCurrent] = args;
        expect(body).toContain("<openclaw-app");
        expect(isCurrent?.()).toBe(true);
        res.once("finish", () => delivered.resolve(res.statusCode));
        entered.resolve();
        await resume.promise;
        await send(...args);
      });
    return {
      entered: entered.promise,
      delivered: delivered.promise,
      resume: resume.resolve,
      restore: () => spy.mockRestore(),
    };
  }

  async function prepareOnlineLoopback(page: Page) {
    // Network-isolated runners can report offline despite this loopback server.
    const protocol = await page.context().newCDPSession(page);
    await protocol.send("Network.overrideNetworkState", {
      offline: false,
      latency: 1,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "ethernet",
    });
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  }

  async function openAcrossPublication(
    page: Page,
    signal: AbortSignal,
    expectedBuild: string,
    maxDocuments: number,
    gateway: MockGatewayControls,
    reload = false,
  ) {
    let documents = 0;
    const observeDocument = (request: Request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        documents += 1;
      }
    };
    page.on("request", observeDocument);
    const start = requests.length;
    const expectedPath = reload ? new URL(page.url()).pathname : publicPath;
    const held = holdAppDelivery();
    // The reader replaces its document during handoff; the app readiness checks below own completion.
    const navigation = reload
      ? page.reload({ waitUntil: "commit" })
      : page.goto(baseUrl + publicPath, { waitUntil: "commit" });
    // Observe rejection immediately while the HTML owner remains intentionally held.
    void navigation.catch(() => {});
    try {
      await withinTest(held.entered, signal);
      if (expectedBuild === buildB) {
        await upsertSessionEntryCore(unrelatedScope, {
          sessionId: unrelatedScope.sessionId,
          updatedAt: ++publication,
          visibility: publication % 2 ? "read-only" : "draft",
        });
        await projection!.ensureMaterialized();
      }
      held.resume();
      // The old global sharing fence redirects here even though this target's
      // permission is unchanged, restarting the reader/probe/entry waterfall.
      const deliveryStatus = await withinTest(held.delivered, signal);
      await navigation;
      await page.waitForFunction(
        () => window.openclawControlUi?.snapshot().ready === true,
        undefined,
        { timeout: controlUiE2eWaitTimeoutMs },
      );
      await page.locator("openclaw-app").waitFor({ state: "visible" });
      expect(await page.evaluate(() => window.openclawControlUi?.snapshot().gatewayPhase)).toBe(
        "connected",
      );
      expect(await page.getByRole("region", { name: "Conversation", exact: true }).count()).toBe(0);
      const connect = (await gateway.getRequests("connect")).at(-1);
      expect(connect?.params).toMatchObject({ client: { buildId: expectedBuild } });
      const entries = requests
        .slice(start)
        .filter(({ path: requestPath }) => requestPath.startsWith("/__openclaw__/session-entry?"));
      const probes = entries.filter(({ path: entryPath }) => entryPath.includes("probe=1")).length;
      const location = new URL(page.url());
      expect({
        deliveryStatus,
        entries: entries.length - probes,
        probes,
        validStatuses: entries.every(({ status }) => status === 200 || status === 204),
        pathname: location.pathname,
        recovery: location.searchParams.has("openclaw_mount_recovery"),
      }).toEqual({
        deliveryStatus: 200,
        entries: 1,
        probes: maxDocuments === 1 ? 0 : 1,
        validStatuses: true,
        pathname: expectedPath,
        recovery: false,
      });
      expect(documents).toBeLessThanOrEqual(maxDocuments);
    } catch (error) {
      if (error instanceof Error) {
        await captureControlUiE2eFailureDiagnostics(page, {
          error,
          label: "post-deploy-session-entry",
        });
      }
      throw error;
    } finally {
      held.resume();
      await Promise.allSettled([navigation]);
      held.restore();
      page.off("request", observeDocument);
    }
  }

  async function installAppGateway(page: Page, serverBuildId: string) {
    await prepareOnlineLoopback(page);
    return installMockGateway(page, {
      serverBuildId,
      sessionKey: publicScope.sessionKey,
      terminalEnabled: false,
    });
  }

  for (const scenarioKind of ["no worker", "controlled reload", "fresh controlled tab"] as const) {
    it(`connects after an unrelated publication and build switch: ${scenarioKind}`, async ({
      signal,
    }) => {
      const controlled = scenarioKind !== "no worker";
      root.path = path.join(fixture!, buildA);
      await using context = await browser!.newContext({
        serviceWorkers: controlled ? "allow" : "block",
        locale: "en-US",
      });
      await context.addCookies([{ name: "operator", value: "1", url: baseUrl }]);
      let page = await context.newPage();
      let gateway = await installAppGateway(page, buildA);
      await openAcrossPublication(page, signal, buildA, 2, gateway);
      if (controlled) {
        await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          await registration.update();
        });
        await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated");
        expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain(
          `v=${buildA}`,
        );
      }
      const fresh = scenarioKind === "fresh controlled tab";
      if (fresh) {
        // The worker outlives the original tab; a new tab has no handoff or
        // mount-recovery history when it meets the replacement deployment.
        await page.close();
        root.path = path.join(fixture!, buildB);
        page = await context.newPage();
        gateway = await installAppGateway(page, buildB);
      } else {
        root.path = path.join(fixture!, buildB);
        await gateway.setServerBuildId(buildB);
      }
      if (scenarioKind === "controlled reload") {
        await page.evaluate((sessionKey) => {
          const url = new URL(location.href);
          url.pathname = "/chat/main/12345678aaaa40008000000000000001";
          url.searchParams.set("__openclawSessionKey", sessionKey);
          url.searchParams.set("__openclawComposerFocus", "1");
          history.replaceState(null, "", url);
        }, publicScope.sessionKey);
      }
      await openAcrossPublication(page, signal, buildB, controlled ? 1 : 2, gateway, !fresh);
      if (fresh) {
        await page.close();
      }
    }, 60_000);
  }

  it.for([false, true])(
    "revalidates a pending handoff and probe (revoked=%s)",
    { timeout: 60_000 },
    async (revoked, { signal }) => {
      const originalConfig = cfg;
      const originalAuth = auth;
      root.path = path.join(fixture!, buildA);
      const proof = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR
        ? createControlUiE2eArtifactDir("session-entry-readiness")
        : undefined;
      await using browserContext = await browser!.newContext({
        serviceWorkers: "allow",
        viewport: { width: 1440, height: 1000 },
        ...(proof ? { recordVideo: { dir: proof, size: { width: 1440, height: 1000 } } } : {}),
      });
      await browserContext.addCookies([{ name: "operator", value: "1", url: baseUrl }]);
      const page = await browserContext.newPage();
      const gateway = await installAppGateway(page, buildA);
      await openAcrossPublication(page, signal, buildA, 2, gateway);
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated");

      const readReady = createDeferred();
      const completion = createDeferred();
      const joined = createDeferred();
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId: "main",
        paths: [databasePath],
        reason: "Source inspection is pending",
        pending: true,
      });
      const pending: PendingAgentDatabaseRecovery = {
        refusal,
        readReady: readReady.promise,
        completion: completion.promise,
        startedAt: 0,
        phase: "inspection",
        phaseStartedAt: 0,
        phaseDurationsMs: {},
      };
      const startup = createAgentDatabaseStartupObservation(new Map([["main", pending]]), signal);
      const wait = startup.waitForAgentPreparation.bind(startup);
      let observers = 0;
      const observedWait = vi
        .spyOn(startup, "waitForAgentPreparation")
        .mockImplementation((...args) => {
          const result = wait(...args);
          if (result && ++observers === 3) {
            joined.resolve();
          }
          return result;
        });
      let revokeRead: (() => void) | undefined;
      let navigation: Promise<unknown> | undefined;
      let documentRequest: Promise<APIResponse> | undefined;
      let probeRequest: Promise<APIResponse> | undefined;
      try {
        recordAgentDatabaseAdmissions([refusal], { source: "startup" });
        gatewayContext.agentDatabaseStartup = startup;
        // A restarted projection captures the real pending source, not the old warm rows.
        projection!.dispose();
        projection = await createSessionRowProjection({
          cfg,
          getConfig: () => cfg,
          modelCatalog: [],
        });
        await projection.ensureMaterialized();
        const start = requests.length;
        root.path = path.join(fixture!, buildB);
        await gateway.setServerBuildId(buildB);
        const response = browserContext.waitForEvent("response", {
          predicate: (result) =>
            result.url().includes("/__openclaw__/session-entry?") &&
            !new URL(result.url()).searchParams.has("probe"),
        });
        void response.catch(() => {});
        // Own the document body independently of the worker serving navigation;
        // Playwright cannot read that worker's response after it closes.
        documentRequest = browserContext.request.get(
          `${baseUrl}/__openclaw__/session-entry?${new URLSearchParams({ path: publicPath })}`,
        );
        void documentRequest.catch(() => {});
        probeRequest = browserContext.request.get(
          `${baseUrl}/__openclaw__/session-entry?${new URLSearchParams({ path: publicPath, probe: "1" })}`,
        );
        void probeRequest.catch(() => {});
        navigation = page.reload({ waitUntil: "commit" });
        void navigation.catch(() => {});
        // A pre-fix 503 fails immediately at the real HTTP boundary instead of timing out.
        expect(
          await withinTest(
            Promise.race([
              joined.promise.then(() => "waiting"),
              response.then((result) => result.status()),
            ]),
            signal,
          ),
        ).toBe("waiting");
        if (revoked) {
          const revokedProxy = { ...trustedProxy, allowUsers: ["other-viewer@example.test"] };
          auth = { ...auth, trustedProxy: revokedProxy };
          cfg = {
            ...cfg,
            gateway: {
              ...cfg.gateway,
              auth: { ...cfg.gateway?.auth, trustedProxy: revokedProxy },
            },
          };
          setRuntimeConfigSnapshot(cfg, cfg);
        }
        revokeRead = publishPendingAgentDatabaseReadAdmission(refusal, {
          paths: [databasePath],
          assertCurrent: () => signal.throwIfAborted(),
        });
        pending.readReady = undefined;
        readReady.resolve();
        sessionChanges.emit({ all: true, scope: { agentId: "main", topology: true } });
        const entryResponse = await response;
        const documentResponse = await documentRequest;
        const probeResponse = await probeRequest;
        expect(await entryResponse.headerValue("cache-control")).toMatch(
          /(?:^|,)\s*no-store\s*(?:,|$)/i,
        );
        for (const result of [documentResponse, probeResponse]) {
          expect(result.headers()["cache-control"]).toMatch(/(?:^|,)\s*no-store\s*(?:,|$)/i);
        }
        await navigation;
        if (revoked) {
          expect([401, 403]).toContain(entryResponse.status());
          expect(await entryResponse.headerValue("x-openclaw-session-entry")).toBeNull();
          for (const result of [documentResponse, probeResponse]) {
            expect([401, 403]).toContain(result.status());
            expect(result.headers()["x-openclaw-session-entry"]).toBeUndefined();
            expect(await result.text()).not.toMatch(/<openclaw-app|type=["']module/);
          }
          await page.getByText(publishedMessage, { exact: true }).waitFor();
          expect(await page.locator("openclaw-app").count()).toBe(0);
        } else {
          expect(entryResponse.status()).toBe(200);
          expect(await entryResponse.headerValue("x-openclaw-session-entry")).toBe("1");
          expect(documentResponse.status()).toBe(200);
          expect(documentResponse.headers()["x-openclaw-session-entry"]).toBe("1");
          expect(await documentResponse.text()).toContain("<openclaw-app");
          expect(probeResponse.status()).toBe(204);
          expect(await probeResponse.body()).toHaveLength(0);
          await page.waitForFunction(() => window.openclawControlUi?.snapshot().ready === true);
          expect(new URL(page.url()).pathname).toBe(publicPath);
          expect((await gateway.getRequests("connect")).at(-1)?.params).toMatchObject({
            client: { buildId: buildB },
          });
          expect(requests.slice(start).filter(({ path: url }) => url.startsWith("/chat/"))).toEqual(
            [],
          );
          expect(
            requests.slice(start).filter(({ path: url }) => url.includes("probe=1")),
          ).toHaveLength(1);
        }
        expect(readAgentDatabaseReadAdmissionRefusal("main")).toBeUndefined();
        expect(readAgentDatabaseAdmissionRefusal("main")).toBe(refusal);
        if (proof) {
          await writeFile(
            path.join(proof, revoked ? "revoked.png" : "recovered.png"),
            await takeControlUiViewportScreenshot(page, page.locator("body"), []),
          );
        }
      } catch (error) {
        if (proof) {
          await page.screenshot({ path: path.join(proof, "failure.png") });
        }
        throw error;
      } finally {
        observedWait.mockRestore();
        pending.readReady = undefined;
        revokeRead?.();
        recordAgentDatabaseAdmissions([], { source: "startup" });
        gatewayContext.agentDatabaseStartup = undefined;
        readReady.resolve();
        completion.resolve();
        // A failing assertion may precede navigation commit. Retire held startup
        // work and settle navigation before closing its page or context.
        await Promise.allSettled([navigation, documentRequest, probeRequest]);
        await page.close();
        cfg = originalConfig;
        auth = originalAuth;
        setRuntimeConfigSnapshot(cfg, cfg);
        projection?.dispose();
        projection = await createSessionRowProjection({
          cfg,
          getConfig: () => cfg,
          modelCatalog: [],
        });
        await projection.ensureMaterialized();
      }
    },
  );

  it("keeps an unauthenticated public-session reload in the reader", async () => {
    root.path = path.join(fixture!, buildB);
    await using context = await browser!.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    let documents = 0;
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        documents += 1;
      }
    });
    const probe = page.waitForResponse(
      (response) => response.url().includes("session-entry?") && response.url().includes("probe=1"),
    );
    expect((await page.goto(baseUrl + publicPath))?.status()).toBe(200);
    expect((await probe).status()).toBe(401);
    await page.getByText(publishedMessage, { exact: true }).waitFor();
    expect(await page.locator("openclaw-app").count()).toBe(0);
    expect(documents).toBe(1);
  });
});
