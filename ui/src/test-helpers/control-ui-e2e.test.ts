// Control UI tests cover control ui e2e behavior.
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import { captureSidebarUiProof } from "../e2e/sidebar-customization.test-support.ts";
import { createControlUiE2eArtifactDir } from "./control-ui-e2e-artifacts.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  installControlUiRpcDiagnostics,
  resolvePlaywrightChromiumExecutablePath,
  systemChromiumExecutableCandidates,
  waitForControlUiRoute,
} from "./control-ui-e2e.ts";

describe("shared proof capture", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
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
      vi.useFakeTimers();
      const parent = tempDirs.make("control-ui-stalled-proof-");
      vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", parent);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const pending = createDeferredCore<Buffer>();
      const screenshot = vi.fn(() =>
        stage === "screenshot" ? pending.promise : Promise.resolve(Buffer.from("proof")),
      );
      // SAFETY: deferred browser replies model an unavailable renderer at the Page boundary.
      const page = {
        evaluate: () =>
          stage === "evaluation"
            ? pending.promise
            : new Promise((resolve) => {
                // A slow read leaves only the remaining capture budget for the screenshot.
                setTimeout(() => resolve({ failureSummary: { available: true } }), 4_000);
              }),
        screenshot,
        frames: () => [],
        isClosed: () => false,
        url: () => "http://fixture.invalid/chat",
      } as unknown as Page;
      const original = new Error("original request failure");
      original.name = "TimeoutError";
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
        const before = readdirSync(root).map((name) => [
          name,
          readFileSync(path.join(root, name), "utf8"),
        ]);
        const report = JSON.parse(readFileSync(path.join(root, "failure.private.json"), "utf8"));
        expect(report.failure).toMatchObject({
          name: "TimeoutError",
          message: original.message,
        });
        expect(report.screenshot).toBeNull();
        expect(report.captureErrors).toEqual([expect.stringContaining("timed out")]);
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
        expect(
          readdirSync(root).map((name) => [name, readFileSync(path.join(root, name), "utf8")]),
        ).toEqual(before);
      } finally {
        pending.resolve(Buffer.from("cleanup"));
        await failedAction;
      }
    },
  );

  it.each([
    { shardIndex: "5", shardCount: "6", failure: "none", sendLabel: "Send message" },
    { shardIndex: undefined, shardCount: undefined, failure: "none", sendLabel: "Loading chat" },
    {
      shardIndex: undefined,
      shardCount: undefined,
      failure: "evaluation",
      sendLabel: "Send message",
    },
    {
      shardIndex: undefined,
      shardCount: undefined,
      failure: "screenshot",
      sendLabel: "private-label",
    },
    {
      shardIndex: undefined,
      shardCount: undefined,
      failure: "storage",
      sendLabel: "Sending message...",
    },
  ])(
    "retains safe failure state despite $failure failure ($sendLabel; $shardIndex/$shardCount)",
    async ({ shardIndex, shardCount, failure, sendLabel }) => {
      vi.useFakeTimers();
      const parent = tempDirs.make("control-ui-failure-proof-");
      const diagnosticParent = failure === "storage" ? path.join(parent, "blocked") : parent;
      if (failure === "storage") {
        writeFileSync(diagnosticParent, "not a directory");
      }
      vi.stubEnv("OPENCLAW_UI_E2E_DIAGNOSTIC_DIR", diagnosticParent);
      const logs = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
      const app = document.createElement("openclaw-app");
      Object.assign(app, {
        runtime: {
          context: {
            gateway: {
              snapshot: {
                phase: failure === "storage" ? "private-phase" : "connected",
                hello: {
                  token: "private-hello",
                  auth: { recoveryScope: "private-recovery" },
                  server: { host: "private-host", address: "private-ip" },
                  device: { id: "private-device" },
                  model: "private-model",
                },
              },
            },
            agents: {
              state: {
                connected: true,
                agentsLoading: failure === "storage" ? "private-loading" : true,
                agentsError: "private-agent-error",
                agentsList: { agents: [{ id: "private-agent" }, { id: "private-agent-two" }] },
              },
            },
            router: {
              getState: () => ({
                status: failure === "storage" ? "private-router-status" : "success",
                matches: [{ routeId: failure === "screenshot" ? "private-route" : "agents" }],
                pendingMatches: [{ routeId: "private-pending-route" }],
                resolvedLocation: {
                  pathname: "/settings/agents/private-agent/files",
                  search: "?token=private-token",
                  hash: "#private-hash",
                },
              }),
            },
          },
        },
      });
      const composer = document.createElement("div");
      composer.className = "agent-chat__composer-combobox";
      const textarea = document.createElement("textarea");
      textarea.value = failure === "storage" ? "" : "private-draft";
      textarea.disabled = failure === "storage";
      composer.append(textarea);
      const send = document.createElement("button");
      send.className = "chat-send-btn--send";
      send.setAttribute("aria-label", sendLabel);
      send.setAttribute("aria-busy", failure === "storage" ? "true" : "false");
      send.disabled = failure !== "none" || sendLabel === "Loading chat";
      const providerHead = document.createElement("div");
      providerHead.className = "model-providers__head";
      const badge = document.createElement("span");
      badge.className = "settings-status";
      badge.textContent = failure === "none" ? "Ready" : "private-badge";
      providerHead.append(badge);
      const agentPage = document.createElement("openclaw-agents-page");
      Object.assign(agentPage, {
        agentsSelectedId: "private-agent",
        agentsPanel: "files",
        agentFileActive: failure === "none" ? "AGENTS.md" : "private-file",
        agentFilesLoading: false,
        agentFilesList: { agentId: "private-agent", workspace: "private-path" },
      });
      const fileEditor = document.createElement("textarea");
      fileEditor.className = "agent-file-textarea";
      fileEditor.value = "private-file-content";
      fileEditor.disabled = failure === "storage";
      if (failure !== "screenshot") {
        agentPage.append(fileEditor);
      }
      const canvasWidgets = ["loading", "error", "frame"].map((stage) => {
        const widget = document.createElement("openclaw-canvas-widget-view");
        widget.setAttribute("doc-id", "private-document");
        const content = document.createElement(stage === "frame" ? "iframe" : "div");
        content.textContent = "private-widget-content";
        if (stage === "loading") {
          content.className = "skeleton";
        } else if (stage === "error") {
          content.setAttribute("role", "alert");
        } else {
          content.className = "chat-tool-card__preview-frame";
          content.setAttribute("title", "private-widget-title");
        }
        widget.append(content);
        return widget;
      });
      document.body.append(app, composer, send, providerHead, agentPage, ...canvasWidgets);
      const modelResponses =
        failure === "none"
          ? {}
          : {
              list: {
                ok: true,
                payload: {
                  models:
                    failure === "screenshot"
                      ? []
                      : [
                          { id: "private-model", available: true },
                          { available: false, unavailableReason: "private-reason" },
                          { available: "private-availability" },
                        ],
                  pendingProviders: [],
                  providerOutcomes:
                    failure === "screenshot"
                      ? []
                      : [
                          {
                            provider: "private-provider",
                            profileId: "private-profile",
                            status: "ready",
                          },
                          { status: "private-outcome" },
                        ],
                },
              },
              authStatus: {
                ok: true,
                payload: {
                  providers:
                    failure === "screenshot"
                      ? []
                      : [
                          {
                            profiles: [
                              {
                                profileId: "private-profile",
                                status: "ok",
                                token: "private-token",
                              },
                              { status: "expired" },
                              { status: "private-health" },
                            ],
                          },
                        ],
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
      // SAFETY: this fixture implements the Page boundary used by failure diagnostics.
      const pageEvents = new EventEmitter();
      const rootFrame = { parentFrame: () => null };
      const outerFrame = { parentFrame: () => rootFrame };
      const innerFrame = { parentFrame: () => outerFrame };
      const page = {
        on: pageEvents.on.bind(pageEvents),
        frames: () => [rootFrame, outerFrame, innerFrame],
        evaluate: async (read: () => unknown) => {
          if (failure === "evaluation") {
            throw new Error("private-evaluation-error");
          }
          return read();
        },
        isClosed: () => false,
        url: () => "http://127.0.0.1/chat",
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
      } as unknown as Page;
      installControlUiRpcDiagnostics(page);
      const socket = new EventEmitter();
      pageEvents.emit("websocket", socket);
      const sendFrame = (direction: string, frame: unknown) =>
        socket.emit(direction, { payload: JSON.stringify(frame) });
      sendFrame("framesent", {
        type: "req",
        id: "private-auth-id",
        method: "connect",
        params: { token: "private-token" },
      });
      sendFrame("framereceived", {
        type: "res",
        id: "private-auth-id",
        ok: true,
        payload: { token: "private-token" },
      });
      sendFrame("framesent", {
        type: "req",
        id: "private-file-id",
        method: "agents.files.get",
        params: { agentId: "private-agent" },
      });
      sendFrame("framereceived", {
        type: "res",
        id: "private-file-id",
        ok: false,
        error: { message: "private-error" },
      });
      for (const ok of [true, false]) {
        sendFrame("framesent", {
          type: "req",
          id: "private-canvas-id",
          method: "canvas.document.view",
          params: { docId: "private-document" },
        });
        sendFrame("framereceived", {
          type: "res",
          id: "private-canvas-id",
          ok,
          payload: { html: "private-html", sandboxUrl: "https://private-host/?private-token" },
          error: { message: "private-canvas-error" },
        });
      }
      const frameEvent = {
        at: "2026-09-01T00:00:00.000Z",
        source: "framenavigated" as const,
        details: { url: "https://private-frame.invalid/?token=private-token" },
      };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const original = new Error("private-original-error");
        original.name = attempt === 0 ? "TimeoutError" : "private-error-name";
        const failedAction = async () => {
          try {
            throw original;
          } catch (error) {
            await captureControlUiE2eFailureDiagnostics(page, {
              error: original,
              label: "private-capture-label",
              modelResponses,
              pageEvents: [frameEvent],
            });
            throw error;
          }
        };
        await expect(failedAction()).rejects.toBe(original);
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
                    editorLength: failure === "screenshot" ? null : fileEditor.value.length,
                    editorDisabled: failure === "screenshot" ? null : fileEditor.disabled,
                  },
                  documentReadyState: expect.stringMatching(/^(?:loading|interactive|complete)$/u),
                  providerStatuses: [
                    {
                      status: failure === "none" ? "Ready" : "unknown",
                      length: badge.textContent.length,
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
  it("uses a runnable system Chromium when the cached Playwright executable cannot start", () => {
    const systemExecutable = systemChromiumExecutableCandidates[1];

    expect(
      resolvePlaywrightChromiumExecutablePath(
        "/cache/chromium/chrome",
        {},
        (candidate) => candidate === systemExecutable,
      ),
    ).toBe(systemExecutable);
  });

  it("keeps explicit Chromium overrides authoritative", () => {
    expect(
      resolvePlaywrightChromiumExecutablePath(
        "/cache/chromium/chrome",
        { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: " /custom/chromium " },
        () => false,
      ),
    ).toBe("/custom/chromium");
  });
});

describe("waitForControlUiRoute", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps polling while a new tab has no app element", async () => {
    // SAFETY: this fixture implements the Page methods used by the route helper.
    const page = {
      async waitForFunction(
        predicate: (target: { routeId: string }) => boolean,
        target: { routeId: string },
      ) {
        expect(predicate(target)).toBe(false);
        const app = document.createElement("openclaw-app");
        Object.assign(app, {
          runtime: {
            router: {
              getState: () => ({
                status: "success",
                resolvedLocation: { pathname: window.location.pathname },
                matches: [{ routeId: "chat" }],
                pendingMatches: [],
              }),
            },
          },
        });
        document.body.append(app);
        expect(predicate(target)).toBe(true);
        return { dispose: vi.fn() };
      },
      evaluate: (read: () => unknown) => read(),
    } as unknown as Page;

    await waitForControlUiRoute(page, { routeId: "chat" });
  });

  it("preserves readiness failures when the app is still absent", async () => {
    const cause = new Error("Route readiness failed");
    // SAFETY: this fixture implements the Page methods used by the route helper.
    const page = {
      waitForFunction: vi.fn().mockRejectedValue(cause),
      evaluate: (read: () => unknown) => read(),
    } as unknown as Page;

    await expect(waitForControlUiRoute(page, { routeId: "chat" })).rejects.toMatchObject({
      cause,
      message: expect.stringContaining('"router":null'),
    });
  });
});
