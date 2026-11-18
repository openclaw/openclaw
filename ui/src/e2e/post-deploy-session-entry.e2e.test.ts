import { cp, mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page, type Request } from "playwright";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../src/config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../../src/config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../../src/config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import * as documentTransport from "../../../src/gateway/control-ui-static.js";
import { createGatewayHttpServer } from "../../../src/gateway/server-http.js";
import { createGatewayRequestContext } from "../../../src/gateway/server-request-context.js";
import { makeContextParams } from "../../../src/gateway/server-request-context.test-support.js";
import { bindSessionRowProjection } from "../../../src/gateway/session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../../../src/gateway/session-row-projection.js";
import { ensureCanonicalUserProfileForEmail } from "../../../src/state/user-profile-writes.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
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
    const trustedProxy = { userHeader: "x-forwarded-user", allowLoopback: true };
    const cfg: OpenClawConfig = {
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
    const context = createGatewayRequestContext(makeContextParams());
    context.resolveGatewayContext = () => context;
    bindSessionRowProjection(context, () => projection);
    root = { kind: "resolved", path: path.join(fixture, buildA) };
    const auth = { mode: "trusted-proxy" as const, trustedProxy, allowTailscale: false };
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
          getGatewayRequestContext: () => context,
          httpRequestLifetime: context,
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
