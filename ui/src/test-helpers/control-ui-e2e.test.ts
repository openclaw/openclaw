import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import type { ControlUiReadiness } from "../app/control-ui-readiness.ts";
import { captureSidebarUiProof } from "../e2e/sidebar-customization.test-support.ts";
import { createControlUiE2eArtifactDir } from "./control-ui-e2e-artifacts.ts";
import {
  installControlUiE2ePageDiagnosticRing,
  recordControlUiE2eFailureFacts,
} from "./control-ui-e2e-diagnostics.ts";
import { installControlUiE2eRendererStallProbe } from "./control-ui-e2e-renderer-stall.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  installControlUiRpcDiagnostics,
  resolvePlaywrightChromiumExecutablePath,
  systemChromiumExecutableCandidates,
  waitForControlUiRoute,
} from "./control-ui-e2e.ts";

const readJson = (root: string, name: string) =>
  JSON.parse(readFileSync(path.join(root, `failure.${name}.json`), "utf8"));
const readFiles = (root: string) =>
  readdirSync(root).map((name) => [name, readFileSync(path.join(root, name), "utf8")]);

// This is the same minimal Page boundary for each capture; cases override only their failing I/O.
function pageFixture(overrides: object) {
  return {
    frames: () => [],
    context: () => ({ browser: () => ({ isConnected: () => true }) }),
    isClosed: () => false,
    url: () => "http://fixture.invalid/chat",
    ...overrides,
  } as unknown as Page;
}

describe("shared proof capture", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  function diagnosticFixture(blocked = false) {
    vi.useFakeTimers();
    const parent = tempDirs.make("control-ui-diagnostics-");
    const diagnosticParent = blocked ? path.join(parent, "blocked") : parent;
    if (blocked) {
      writeFileSync(diagnosticParent, "not a directory");
    }
    vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", diagnosticParent);
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    return { parent, diagnosticParent, logs };
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it.each([
    { stage: "evaluation", late: "resolve" },
    { stage: "evaluation", late: "reject" },
    { stage: "screenshot", late: "resolve" },
    { stage: "screenshot", late: "reject" },
  ])(
    "preserves the original failure when diagnostic $stage stalls then $late arrives late",
    async ({ stage, late }) => {
      const { parent } = diagnosticFixture();
      const pending = createDeferredCore<Buffer>();
      const screenshot = vi.fn(() =>
        stage === "screenshot" ? pending.promise : Promise.resolve(Buffer.from("proof")),
      );
      const page = pageFixture({
        evaluate: () =>
          stage === "evaluation"
            ? pending.promise
            : new Promise((resolve) => {
                // A slow read leaves only the remaining capture budget for the screenshot.
                setTimeout(() => resolve({ failureSummary: { available: true } }), 4_000);
              }),
        screenshot,
      });
      const original = new Error("original request failure");
      original.name = "TimeoutError";
      recordControlUiE2eFailureFacts(page, { avatarPresent: false, avatarRequests: 1 });
      let observed: unknown;
      const failedAction = (async () => {
        await captureControlUiE2eFailureDiagnostics(page, {
          error: original,
          label: "chat.send",
        });
        throw original;
      })().catch((error: unknown) => {
        observed = error;
      });
      try {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(observed).toBe(original);
        expect(vi.getTimerCount()).toBe(0);
        const directories = readdirSync(parent);
        expect(directories).toHaveLength(1);
        const root = path.join(parent, directories[0]!);
        const before = readFiles(root);
        const report = readJson(root, "private");
        expect(readJson(root, "public")).toMatchObject({
          hostBeforeRead: { pageClosed: false, browserConnected: true },
          lifecycle: null,
          rendererRead: stage === "evaluation" ? "deadline" : "completed",
          scenarioFacts: { avatarPresent: false, avatarRequests: 1 },
        });
        expect(report).toMatchObject({
          failure: { name: "TimeoutError", message: original.message },
          screenshot: null,
          captureErrors: [expect.stringContaining("timed out")],
        });
        if (stage === "evaluation") {
          expect(screenshot).not.toHaveBeenCalled();
        }
        if (late === "resolve") {
          pending.resolve(Buffer.from("late proof"));
        } else {
          pending.reject(new Error("late renderer failure"));
        }
        await vi.runAllTimersAsync();
        await failedAction;
        expect(readFiles(root)).toEqual(before);
      } finally {
        pending.resolve(Buffer.from("cleanup"));
        await failedAction;
      }
    },
  );

  it.each([
    { stall: "script", paused: true, metrics: true },
    { stall: "native", paused: false, metrics: true },
    { stall: "unavailable metrics", paused: true, metrics: false },
  ])(
    "publishes $stall renderer stall evidence without page origins",
    async ({ paused, metrics }) => {
      const { parent } = diagnosticFixture();
      const sent: string[] = [];
      let samples = 0;
      const session = Object.assign(new EventEmitter(), {
        send: async (method: string) => {
          sent.push(method);
          if (method === "Debugger.enable") {
            for (const [scriptId, url] of [
              ["bundle", "http://127.0.0.1:4173/assets/index-private.js?token=private"],
              ["blob", "blob:https://private.invalid/id"],
              ["private-path", "https://private.invalid/private-session/report.js?token=private"],
            ]) {
              session.emit("Debugger.scriptParsed", { scriptId, url });
            }
          }
          if (method === "Performance.getMetrics") {
            if (!metrics) {
              return new Promise(() => {});
            }
            samples += 1;
            const elapsed = samples === 1 ? 0 : 0.5;
            return {
              metrics: [
                { name: "TaskDuration", value: 10 + elapsed },
                { name: "ScriptDuration", value: 4 + elapsed },
                { name: "LayoutDuration", value: 1 },
              ],
            };
          }
          if (method === "Debugger.pause" && paused) {
            queueMicrotask(() =>
              session.emit("Debugger.paused", {
                callFrames: (
                  [
                    ["layoutPins", "bundle", "", 9, 3],
                    ["", "blob", "blob:https://private.invalid/id", 0, 0],
                    ["privatePath", "private-path", "", 0, 0],
                  ] as const
                ).map(([functionName, scriptId, url, lineNumber, columnNumber]) => ({
                  functionName,
                  url,
                  location: { scriptId, lineNumber, columnNumber },
                })),
              }),
            );
          }
          return {};
        },
        detach: async () => {
          sent.push("detach");
        },
      });
      const stalled = createDeferredCore<unknown>();
      const page = pageFixture({
        addInitScript: async () => {},
        evaluate: () => stalled.promise,
        screenshot: async () => Buffer.from("proof"),
        context: () => ({
          browser: () => ({ isConnected: () => true }),
          newCDPSession: async () => session,
        }),
      });
      await installControlUiE2eRendererStallProbe(page);
      const capture = captureControlUiE2eFailureDiagnostics(page, {
        error: new Error("click timed out"),
        label: "comment pin",
      });
      await vi.advanceTimersByTimeAsync(5_000 + 3_000);
      await capture;
      const root = path.join(parent, readdirSync(parent)[0]!);
      const report = readJson(root, "public");
      expect(report).toMatchObject({
        rendererRead: "deadline",
        rendererStall: {
          busyMs: metrics ? { task: 500, script: 500, layout: 0, style: 0 } : null,
          sampleMs: metrics ? 500 : 0,
          stack: paused
            ? [
                {
                  functionName: "layoutPins",
                  script: "/assets/index-private.js",
                  line: 10,
                  column: 4,
                },
                { functionName: "(anonymous)", script: "", line: 1, column: 1 },
                { functionName: "privatePath", script: "", line: 1, column: 1 },
              ]
            : null,
        },
      });
      expect(JSON.stringify(report)).not.toMatch(/token=private|private\.invalid|private-session/u);
      expect(sent).toContain("Debugger.pause");
      expect(sent.slice(-2)).toEqual(["Debugger.resume", "detach"]);
      expect(session.listenerCount("Debugger.scriptParsed")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      stalled.resolve(null);
    },
  );

  it.each([
    { observed: true, closed: false, connected: true },
    { observed: false, closed: true, connected: false },
    { observed: false, closed: false, connected: false },
    { observed: false, closed: false, connected: null },
    { observed: false, closed: false, connected: true },
  ])(
    "retains only observed lifecycle facts ($observed/$closed/$connected)",
    async ({ observed, closed: initiallyClosed, connected: initiallyConnected }) => {
      let closed = initiallyClosed;
      let connected = initiallyConnected;
      const { parent, logs } = diagnosticFixture();
      const browserEvents = new EventEmitter();
      const reads: string[] = [];
      const browser = Object.assign(browserEvents, {
        isConnected: () => {
          reads.push("browser-connected");
          return connected;
        },
      });
      const registeredAt = new Date().toISOString();
      const pageEvents = new EventEmitter();
      // SAFETY: event emitters model the supported Playwright host-side lifecycle boundary.
      const page = Object.assign(pageEvents, {
        context: () => ({ browser: () => (connected === null ? null : browser) }),
        isClosed: () => {
          reads.push("page-closed");
          return closed;
        },
        frames: () => [],
        url: () => "https://fixture.invalid/chat",
        evaluate: async () => {
          reads.push("evaluate");
          if (observed) {
            throw new Error("private-renderer-error");
          }
          return { failureSummary: { available: true } };
        },
        screenshot: async () => Buffer.from("proof"),
      }) as unknown as Page;
      const events = installControlUiE2ePageDiagnosticRing(page);
      const reinstalled = installControlUiE2ePageDiagnosticRing(page);
      expect(browserEvents.listenerCount("disconnected")).toBe(connected ? 1 : 0);
      if (closed) {
        expect(pageEvents.eventNames()).toEqual([]);
      }
      const lifecycle: {
        registeredAt: string;
        firstCrashAt: string | null;
        firstCloseAt: string | null;
        firstBrowserDisconnectAt: string | null;
      } = {
        registeredAt,
        firstCrashAt: null,
        firstCloseAt: null,
        firstBrowserDisconnectAt: null,
      };
      if (observed) {
        expect(reinstalled).toBe(events);
        expect(logs).not.toHaveBeenCalled();
        vi.setSystemTime(Date.now() + 1_000);
        lifecycle.firstCrashAt = new Date().toISOString();
        pageEvents.emit("crash", page);
        vi.setSystemTime(Date.now() + 1_000);
        lifecycle.firstBrowserDisconnectAt = new Date().toISOString();
        connected = false;
        browserEvents.emit("disconnected", browser);
        vi.setSystemTime(Date.now() + 1_000);
        lifecycle.firstCloseAt = new Date().toISOString();
        closed = true;
        pageEvents.emit("close", page);
        expect(pageEvents.listenerCount("crash")).toBe(0);
        expect(pageEvents.listenerCount("console")).toBe(0);
        expect(browserEvents.listenerCount("disconnected")).toBe(0);
        installControlUiE2ePageDiagnosticRing(page);
        expect(browserEvents.listenerCount("disconnected")).toBe(0);
        vi.setSystemTime(Date.now() + 1_000);
        pageEvents.emit("crash", page);
        pageEvents.emit("close", page);
        browserEvents.emit("disconnected", browser);
      }
      expect(logs).not.toHaveBeenCalled();
      reads.length = 0;
      await captureControlUiE2eFailureDiagnostics(page, {
        error: new Error("failure"),
        label: "test",
      });
      const root = path.join(parent, readdirSync(parent)[0]!);
      const report = readJson(root, "public");
      expect(report).toMatchObject({
        hostBeforeRead: { pageClosed: closed, browserConnected: connected },
        lifecycle,
        rendererRead: observed ? "rejected" : "completed",
      });
      if (observed) {
        expect(reads.slice(0, 3)).toEqual(["page-closed", "browser-connected", "evaluate"]);
      }
      expect(JSON.stringify(report)).not.toContain("private-");
      expect(vi.getTimerCount()).toBe(0);
      pageEvents.emit("close", page);
      expect(browserEvents.listenerCount("disconnected")).toBe(0);
    },
  );

  it.each([
    ["none", "Send message", "snapshot", "5", "6"],
    ["none", "Loading chat", "none", undefined, undefined],
    ["evaluation", "Send message", "list", undefined, undefined],
    ["screenshot", "private-label", "list", undefined, undefined],
    ["storage", "Sending message...", "list", undefined, undefined],
  ] as const)(
    "retains safe failure state despite %s failure (%s; %s catalog; %s/%s)",
    async (failure, sendLabel, catalogSource, shardIndex, shardCount) => {
      const { parent, diagnosticParent, logs } = diagnosticFixture(failure === "storage");
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
      vi.stubGlobal("openclawControlUi", {
        snapshot: (): ReturnType<ControlUiReadiness["hook"]["snapshot"]> => ({
          generation: 7,
          booted: true,
          gatewayPhase: "connected",
          routeReady: true,
          rosterReady: false,
          ready: false,
          basePath: "/private-base",
          sessionKey: "private-session",
          route: null,
          terminalActivationReady: false,
        }),
        diagnostics: () => ({
          settlementError: failure === "storage" ? "private-settlement-error" : null,
          gateway: {
            phase: failure === "storage" ? "private-phase" : "connected",
            hello: {
              token: "private-hello",
              auth: { recoveryScope: "private-recovery" },
              server: { host: "private-host", address: "private-ip" },
              device: { id: "private-device" },
              model: "private-model",
            },
          },
          roster: {
            connected: true,
            agentsLoading: failure === "storage" ? "private-loading" : true,
            agentsError: "private-agent-error",
            agentsList: { agents: [{ id: "private-agent" }, { id: "private-agent-two" }] },
          },
          router: {
            status: failure === "storage" ? "private-router-status" : "success",
            matches: [{ routeId: failure === "screenshot" ? "private-route" : "agents" }],
            pendingMatches: [{ routeId: "private-pending-route" }],
            resolvedLocation: {
              pathname: "/settings/agents/private-agent/files",
              search: "?token=private-token",
              hash: "#private-hash",
            },
          },
        }),
      });
      const storageFailed = failure === "storage";
      const screenshotFailed = failure === "screenshot";
      const sendDisabled = failure !== "none" || sendLabel === "Loading chat";
      const badgeText = failure === "none" ? "Ready" : "private-badge";
      const fileText = "private-file-content";
      const dom = document.createElement("div");
      dom.innerHTML = `
        <openclaw-app></openclaw-app>
        <div class="agent-chat__composer-combobox"><textarea ${storageFailed ? "disabled" : ""}>${storageFailed ? "" : "private-draft"}</textarea></div>
        <button class="chat-send-btn--send" aria-label="${sendLabel}" aria-busy="${storageFailed}" ${sendDisabled ? "disabled" : ""}></button>
        <div class="model-providers__head"><span class="settings-status">${badgeText}</span></div>
        <openclaw-agents-page>${screenshotFailed ? "" : `<textarea class="agent-file-textarea" ${storageFailed ? "disabled" : ""}>${fileText}</textarea>`}</openclaw-agents-page>
        <openclaw-canvas-widget-view doc-id="private-document"><div class="skeleton">private-widget-content</div></openclaw-canvas-widget-view>
        <openclaw-canvas-widget-view doc-id="private-document"><div role="alert">private-widget-content</div></openclaw-canvas-widget-view>
        <openclaw-canvas-widget-view doc-id="private-document"><iframe class="chat-tool-card__preview-frame" title="private-widget-title">private-widget-content</iframe></openclaw-canvas-widget-view>`;
      Object.assign(dom.querySelector("openclaw-agents-page")!, {
        agentsSelectedId: "private-agent",
        agentsPanel: "files",
        agentFileActive: failure === "none" ? "AGENTS.md" : "private-file",
        agentFilesLoading: false,
        agentFilesList: { agentId: "private-agent", workspace: "private-path" },
      });
      document.body.append(...dom.childNodes);
      const snapshot =
        catalogSource === "snapshot"
          ? {
              event: "models.snapshot",
              payload: {
                scope: { agentId: "private-agent" },
                catalog: {
                  models: [{ id: "private-model", available: true }],
                  pendingProviders: ["private-provider"],
                  providerOutcomes: [{ provider: "private-provider", status: "ready" }],
                },
              },
            }
          : undefined;
      const unlessEmpty = <T>(items: T[]) => (failure === "screenshot" ? [] : items);
      const modelResponses =
        catalogSource !== "list"
          ? { snapshot }
          : {
              list: {
                ok: true,
                payload: {
                  models: unlessEmpty([
                    { id: "private-model", available: true },
                    { available: false, unavailableReason: "private-reason" },
                    { available: "private-availability" },
                  ]),
                  pendingProviders: [],
                  providerOutcomes: unlessEmpty([
                    { provider: "private-provider", profileId: "private-profile", status: "ready" },
                    { status: "private-outcome" },
                  ]),
                },
              },
              authStatus: {
                ok: true,
                payload: {
                  providers: unlessEmpty([
                    {
                      profiles: [
                        { profileId: "private-profile", status: "ok", token: "private-token" },
                        { status: "expired" },
                        { status: "private-health" },
                      ],
                    },
                  ]),
                },
              },
            };
      vi.stubEnv("VITEST_SHARD_INDEX", shardIndex);
      vi.stubEnv("VITEST_SHARD_COUNT", shardCount);
      vi.stubEnv("SHARD_INDEX", shardIndex ? undefined : "unrelated-shard");
      vi.stubEnv("GITHUB_JOB", "checks-ui-e2e");
      vi.stubEnv("GITHUB_RUN_ID", "123456");
      vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
      writeFileSync(path.join(parent, "prior.png"), "prior-proof");
      const pageEvents = new EventEmitter();
      const rootFrame = { parentFrame: () => null };
      const outerFrame = { parentFrame: () => rootFrame };
      const innerFrame = { parentFrame: () => outerFrame };
      const page = pageFixture({
        on: pageEvents.on.bind(pageEvents),
        frames: () => [rootFrame, outerFrame, innerFrame],
        evaluate: async (read: () => unknown) => {
          if (failure === "evaluation") {
            throw new Error("private-evaluation-error");
          }
          return read();
        },
        screenshot: async () => {
          expect(
            logs.mock.calls.some(([message]) => message === "[control-ui-e2e] failure state"),
          ).toBe(true);
          expect(
            readdirSync(diagnosticParent).some((name) =>
              existsSync(path.join(diagnosticParent, name, "failure.public.json")),
            ),
          ).toBe(true);
          if (failure === "screenshot") {
            throw new Error("private-screenshot-error");
          }
          return Buffer.from("failure-proof");
        },
      });
      installControlUiRpcDiagnostics(page);
      const socket = new EventEmitter();
      pageEvents.emit("websocket", socket);
      const sendFrame = (direction: string, frame: unknown) =>
        socket.emit(direction, { payload: JSON.stringify(frame) });
      const rpc = (method: string, params: unknown, response: object) => {
        const id = `private-${method}`;
        sendFrame("framesent", { type: "req", id, method, params });
        sendFrame("framereceived", { type: "res", id, ...response });
      };
      rpc("connect", { token: "private-token" }, { ok: true, payload: { token: "private-token" } });
      rpc(
        "agents.files.get",
        { agentId: "private-agent" },
        {
          ok: false,
          error: { message: "private-error" },
        },
      );
      for (const ok of [true, false]) {
        rpc(
          "canvas.document.view",
          { docId: "private-document" },
          {
            ok,
            payload: { html: "private-html", sandboxUrl: "https://private-host/?private-token" },
            error: { message: "private-canvas-error" },
          },
        );
      }
      const frameEvent = {
        at: "2026-09-01T00:00:00.000Z",
        source: "framenavigated" as const,
        details: { url: "https://private-frame.invalid/?token=private-token" },
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const original = new Error("private-original-error");
        original.name = attempt === 0 ? "TimeoutError" : "private-error-name";
        await captureControlUiE2eFailureDiagnostics(page, {
          error: original,
          label: "private-capture-label",
          modelResponses,
          pageEvents: [frameEvent],
        });
        expect(vi.getTimerCount()).toBe(0);
      }
      const directories = readdirSync(parent, { withFileTypes: true }).filter((entry) =>
        entry.isDirectory(),
      );
      const renderedSummaries = logs.mock.calls
        .filter(([message]) => message === "[control-ui-e2e] failure state")
        .map((args) => format(...args));
      expect(renderedSummaries).toHaveLength(2);
      const publicSummaries: unknown[] = [];
      for (const [attempt, rendered] of renderedSummaries.entries()) {
        expect(rendered).not.toContain("[Object]");
        expect(rendered).not.toContain("private-");
        const summary = JSON.parse(rendered.slice("[control-ui-e2e] failure state ".length));
        publicSummaries.push(summary);
        expect(summary).toMatchObject({
          hostBeforeRead: { pageClosed: false, browserConnected: true },
          lifecycle: null,
          rendererRead: failure === "evaluation" ? "rejected" : "completed",
          gatewayRpc: [
            { method: "agents.files.get", outcome: "sent" },
            { method: "agents.files.get", outcome: "error" },
            { method: "canvas.document.view", outcome: "sent" },
            { method: "canvas.document.view", outcome: "ok" },
            { method: "canvas.document.view", outcome: "sent" },
            { method: "canvas.document.view", outcome: "error" },
          ],
          frameDepthCounts: [1, 1, 1],
          schemaVersion: 1,
          failureKind: attempt === 0 ? "timeout" : "unknown",
          route: {
            pathname:
              failure === "evaluation" || failure === "screenshot" ? null : "/settings/agents",
            agentPanel: failure === "evaluation" || failure === "screenshot" ? null : "files",
            status: failure === "evaluation" || failure === "storage" ? "unknown" : "success",
            matches: failure === "evaluation" ? null : 1,
            pendingMatches: failure === "evaluation" ? null : 1,
          },
          browser:
            failure === "evaluation"
              ? { available: false }
              : {
                  readiness: {
                    generation: 7,
                    booted: true,
                    gatewayPhase: "connected",
                    routeReady: true,
                    rosterReady: false,
                    ready: false,
                    settlementFailed: failure === "storage",
                  },
                  gatewayPhase: failure === "storage" ? "unknown" : "connected",
                  connected: true,
                  canvasWidgets: [
                    { loading: true, errorPresent: false, framePresent: false },
                    { loading: false, errorPresent: true, framePresent: false },
                    { loading: false, errorPresent: false, framePresent: true },
                  ],
                  roster: {
                    loading: failure === "storage" ? null : true,
                    count: 2,
                    errorPresent: true,
                  },
                  agentFiles: {
                    pathname: "other",
                    pagePresent: true,
                    selectedAgentPresent: true,
                    selectionMatchesPath: null,
                    listMatchesSelection: true,
                    panel: "files",
                    activeFile: failure === "none" ? "AGENTS.md" : "unknown",
                    loading: false,
                    editorPresent: failure !== "screenshot",
                    editorLength: screenshotFailed ? null : fileText.length,
                    editorDisabled: screenshotFailed ? null : storageFailed,
                  },
                  documentReadyState: expect.stringMatching(/^(?:loading|interactive|complete)$/u),
                  providerStatuses: [
                    {
                      status: failure === "none" ? "Ready" : "unknown",
                      length: badgeText.length,
                    },
                  ],
                  composer: {
                    draftLength: failure === "storage" ? 0 : 13,
                    nonempty: failure !== "storage",
                    disabled: failure === "storage",
                    send: {
                      label: sendLabel === "private-label" ? "unknown" : sendLabel,
                      labelLength: sendLabel.length,
                      disabled: failure !== "none" || sendLabel === "Loading chat",
                      busy: failure === "storage",
                    },
                  },
                },
          models: {
            listSeen: failure !== "none",
            listOk: failure === "none" ? null : true,
            snapshot: {
              seen: snapshot !== undefined,
              models: snapshot ? 1 : null,
              available: snapshot ? 1 : null,
              unavailable: snapshot ? 0 : null,
              unknownAvailability: snapshot ? 0 : null,
              pendingProviders: snapshot ? 1 : null,
              providerOutcomes: snapshot
                ? { ready: 1, "auth-rejected": 0, unavailable: 0, unknown: 0 }
                : null,
            },
            models: failure === "none" ? null : failure === "screenshot" ? 0 : 3,
            available: failure === "none" ? null : failure === "screenshot" ? 0 : 1,
            unavailable: failure === "none" ? null : failure === "screenshot" ? 0 : 1,
            unknownAvailability: failure === "none" ? null : failure === "screenshot" ? 0 : 1,
            pendingProviders: failure === "none" ? null : 0,
            providerOutcomes:
              failure === "none"
                ? null
                : {
                    ready: failure === "storage" || failure === "evaluation" ? 1 : 0,
                    "auth-rejected": 0,
                    unavailable: 0,
                    unknown: failure === "storage" || failure === "evaluation" ? 1 : 0,
                  },
            authSeen: failure !== "none",
            authOk: failure === "none" ? null : true,
            profiles:
              failure === "none"
                ? null
                : {
                    ok: failure === "storage" || failure === "evaluation" ? 1 : 0,
                    expiring: 0,
                    expired: failure === "storage" || failure === "evaluation" ? 1 : 0,
                    missing: 0,
                    static: 0,
                    unknown: failure === "storage" || failure === "evaluation" ? 1 : 0,
                  },
          },
        });
      }
      expect(JSON.stringify(logs.mock.calls)).not.toContain("private-");
      expect(directories).toHaveLength(failure === "storage" ? 0 : 2);
      for (const directory of directories) {
        const root = path.join(parent, directory.name);
        const files = readdirSync(root);
        expect(files).toHaveLength(failure === "screenshot" ? 2 : 3);
        const publicJson = readFileSync(path.join(root, "failure.public.json"), "utf8");
        expect(publicJson).not.toContain("private-");
        expect(publicSummaries).toContainEqual(JSON.parse(publicJson));
        const report = JSON.parse(readFileSync(path.join(root, "failure.private.json"), "utf8"));
        expect(report).toMatchObject({
          label: "private-capture-label",
          pageEvents: [frameEvent],
          captureErrors:
            failure === "screenshot"
              ? [expect.stringContaining("private-screenshot-error")]
              : failure === "evaluation"
                ? [expect.stringContaining("private-evaluation-error")]
                : [],
          ci: {
            githubJob: "checks-ui-e2e",
            runAttempt: "2",
            runId: "123456",
            shardIndex: shardIndex ?? null,
            vitestShardCount: shardCount ?? null,
          },
        });
        if (failure === "screenshot") {
          expect(report.screenshot).toBeNull();
        } else {
          expect(files).toContain(report.screenshot);
          expect(readFileSync(path.join(root, report.screenshot), "utf8")).toBe("failure-proof");
        }
      }
      expect(readFileSync(path.join(parent, "prior.png"), "utf8")).toBe("prior-proof");
    },
  );

  it("keeps shared capture disabled until its gate is enabled and uses the supplied owner", async () => {
    const parent = tempDirs.make("control-ui-proof-capture-");
    vi.stubEnv("OPENCLAW_UI_E2E_ARTIFACT_DIR", parent);
    vi.stubEnv("OPENCLAW_CAPTURE_UI_PROOF", "0");
    let directory: string | undefined;
    const owner = {
      get artifactDir() {
        return (directory ??= createControlUiE2eArtifactDir("sidebar", parent));
      },
    };
    const screenshot = vi.fn(async (options: { path: string }) => {
      // A broken caller must fail before it can write outside this test's owned directory.
      expect(options.path).toBe(path.join(owner.artifactDir, "state.png"));
      writeFileSync(options.path, "sidebar-proof");
      return Buffer.from("sidebar-proof");
    });
    const video = vi.fn(() => null);
    // SAFETY: this fixture implements the non-recording Page boundary used by the capture helper.
    const page = { screenshot, video } as unknown as Page;

    await captureSidebarUiProof(owner, page, "state.png");
    expect(readdirSync(parent)).toEqual([]);
    expect(screenshot).not.toHaveBeenCalled();
    expect(video).not.toHaveBeenCalled();

    vi.stubEnv("OPENCLAW_CAPTURE_UI_PROOF", "1");
    await captureSidebarUiProof(owner, page, "state.png");
    expect(readFileSync(path.join(owner.artifactDir, "state.png"), "utf8")).toBe("sidebar-proof");
  });
});

describe("resolvePlaywrightChromiumExecutablePath", () => {
  it.each([
    {
      override: undefined,
      runnable: systemChromiumExecutableCandidates[1],
      expected: systemChromiumExecutableCandidates[1],
    },
    { override: " /custom/chromium ", runnable: undefined, expected: "/custom/chromium" },
  ])(
    "selects the override $override or runnable system browser $runnable",
    ({ override, runnable, expected }) => {
      expect(
        resolvePlaywrightChromiumExecutablePath(
          "/cache/chromium/chrome",
          { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: override },
          (candidate) => candidate === runnable,
        ),
      ).toBe(expected);
    },
  );

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("prefers the newest installed Chromium revision over system browsers", () => {
    const browsersRoot = tempDirs.make("control-ui-playwright-browsers-");
    const installed = [
      path.join(browsersRoot, "chromium-1100", "chrome-linux", "chrome"),
      path.join(browsersRoot, "chromium-1194", "chrome-linux", "chrome"),
    ];
    for (const executable of installed) {
      mkdirSync(path.dirname(executable), { recursive: true });
      writeFileSync(executable, "");
    }

    expect(
      resolvePlaywrightChromiumExecutablePath(
        path.join(browsersRoot, "chromium-1243", "chrome-linux64", "chrome"),
        {},
        (candidate) =>
          existsSync(candidate) || candidate === systemChromiumExecutableCandidates.at(-1),
      ),
    ).toBe(installed[1]);
  });
});

describe("waitForControlUiRoute", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it.each([false, true])("waits for the app or preserves readiness failure (%s)", async (fails) => {
    const cause = new Error("Route readiness failed");
    // SAFETY: this fixture implements the Page methods used by the route helper.
    const page = {
      async waitForFunction(
        predicate: (target: { routeId: string }) => boolean,
        target: { routeId: string },
      ) {
        if (fails) {
          throw cause;
        }
        expect(predicate(target)).toBe(false);
        const app = document.createElement("openclaw-app");
        vi.stubGlobal("openclawControlUi", {
          snapshot: () => ({
            routeReady: true,
            route: {
              status: "success",
              resolvedLocation: { pathname: window.location.pathname },
              matches: [{ routeId: "chat" }],
              pendingMatches: [],
            },
          }),
        });
        document.body.append(app);
        expect(predicate(target)).toBe(true);
        return { dispose: vi.fn() };
      },
      evaluate: (read: () => unknown) => read(),
    } as unknown as Page;

    const ready = waitForControlUiRoute(page, { routeId: "chat" });
    if (fails) {
      await expect(ready).rejects.toMatchObject({
        cause,
        message: expect.stringContaining('"router":null'),
      });
    } else {
      await ready;
    }
  });
});
