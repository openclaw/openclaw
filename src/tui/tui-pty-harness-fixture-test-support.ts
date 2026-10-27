// Generates the shared fake-backend terminal fixture.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "esbuild";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { TUI_PTY_FALLBACK_FIXTURE } from "./tui-fallback-fixture-test-support.js";
import { TUI_PTY_ASSISTANT_FIXTURE_SCRIPT } from "./tui-pty-assistant-fixture-test-support.js";
import { TUI_PTY_GAP_HISTORY_FIXTURE_SCRIPT } from "./tui-pty-gap-fixture-test-support.js";
import {
  waitForFixtureLogEntry,
  type FixtureLogEntry,
} from "./tui-pty-harness-assertion-test-support.js";
import { tuiFixtureReceipts, tuiFixtureRecordSource } from "./tui-pty-receipts-test-support.js";
import {
  createTuiReconnectRelease,
  TUI_PTY_RECONNECT_FIXTURE,
} from "./tui-pty-reconnect-fixture-test-support.js";
import { TUI_PTY_RENDERING_FIXTURE_SCRIPT } from "./tui-pty-rendering-test-support.js";
import { TUI_PTY_RESET_FIXTURE } from "./tui-pty-reset-fixture-test-support.js";
import { tuiPtyRuntimeEntrypoints } from "./tui-pty-runtime-test-support.js";
import {
  createTuiStartupRelease,
  TUI_PTY_STARTUP_SESSION_FIXTURE,
  type TuiStartupFixtureOptions,
} from "./tui-pty-startup-session-fixture-test-support.js";
import { TUI_PTY_SESSION_SUBSCRIPTION_FIXTURE_SCRIPT } from "./tui-pty-subscription-fixture-test-support.js";
import { TUI_PTY_TASK_FIXTURE } from "./tui-pty-task-fixture-test-support.js";
import { startRuntimePty, type PtyRun } from "./tui-pty-test-support.js";

export * from "./tui-pty-harness-assertion-test-support.js";

export { tuiFixtureReceipts } from "./tui-pty-receipts-test-support.js";

const activeRuns: PtyRun[] = [];
const EXIT_TIMEOUT_MS = 4_000;

export async function disposeActiveTuiFixtures(): Promise<void> {
  for (const run of activeRuns.splice(0)) {
    await run.dispose();
  }
}

export async function startTuiFixture(
  opts: TuiStartupFixtureOptions & {
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    holdReconnect?: boolean;
  } = {},
) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-"));
  const configPath = path.join(tempDir, "openclaw.json");
  await writeFile(configPath, "{}\n");
  const scriptPath = await writeTuiPtyFixtureScript(tempDir, opts);
  const logPath = path.join(tempDir, "fixture-log.jsonl");
  const startupRelease = createTuiStartupRelease(tempDir, opts);
  const reconnectRelease = createTuiReconnectRelease(tempDir, opts.holdReconnect);
  const execPath = opts.execPath ?? process.execPath;
  const run = await startRuntimePty(
    execPath,
    resolveRuntimeWorkerArgv(pathToFileURL(scriptPath), execPath),
    {
      activeRuns,
      cwd: process.cwd(),
      env: {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_THEME: "dark",
        OPENCLAW_TUI_PTY_LOG_PATH: logPath,
        // This virtual terminal does not implement OSC 7501 program-status replies.
        PI_PROGRAM_STATUS: "0",
        NO_COLOR: undefined,
        ...opts.env,
        ...startupRelease.env,
        ...reconnectRelease.env,
      },
      exitTimeoutMs: EXIT_TIMEOUT_MS,
      outputTimeoutMs: 2_000,
    },
  );

  startupRelease.wrapDispose(run);
  reconnectRelease.wrapDispose(run);

  return {
    run,
    logPath,
    releaseStartup: startupRelease.releaseStartup,
    releaseReconnect: reconnectRelease.releaseReconnect,
    waitForLogEntry: async (
      predicate: (entry: FixtureLogEntry, index: number) => boolean,
      signal: AbortSignal,
    ) =>
      await waitForFixtureLogEntry(logPath, predicate, {
        receipts: tuiFixtureReceipts,
        run,
        signal,
      }),
    cleanup: async () => {
      await run.dispose();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

export async function writeTuiPtyFixtureScript(dir: string, opts: TuiStartupFixtureOptions = {}) {
  const tuiUrl = resolveRuntimeWorkerUrl(tuiPtyRuntimeEntrypoints.tui);
  const prepared = tuiUrl.pathname.endsWith(".js");
  // Direct source runs retain TSX; prepared runs compile this final generated fixture before launch.
  const scriptPath = path.join(dir, `run-tui-pty-fixture.${prepared ? "mjs" : "mts"}`);
  const tuiModuleUrl = tuiUrl.href;
  const tuiBackendTypeUrl = pathToFileURL(path.join(process.cwd(), "src/tui/tui-backend.ts")).href;
  const source = `
      ${tuiFixtureRecordSource()}
      import { existsSync, watch, watchFile, unwatchFile } from "node:fs";
      import { dirname, join } from "node:path";
      import { DatabaseSync } from "node:sqlite";
      import type { TuiBackend } from ${JSON.stringify(tuiBackendTypeUrl)};
      import { runTui } from ${JSON.stringify(tuiModuleUrl)};

      const gatewayStatus = process.env.OPENCLAW_TUI_PTY_GATEWAY_STATUS ?? "fixture gateway ok";
      const startupDelayMs = Number(process.env.OPENCLAW_TUI_PTY_STARTUP_DELAY_MS ?? 0);
      ${TUI_PTY_STARTUP_SESSION_FIXTURE.variables(opts.failInitialHistory === true)}
      const footerModel = process.env.OPENCLAW_TUI_PTY_MODEL;
      const footerThinkingLevel = process.env.OPENCLAW_TUI_PTY_THINKING_LEVEL;
      let verboseLevel = process.env.OPENCLAW_TUI_PTY_VERBOSE_LEVEL;
      const launchThinkingLevel = process.env.OPENCLAW_TUI_PTY_LAUNCH_THINKING;
      const initialMessage = process.env.OPENCLAW_TUI_PTY_INITIAL_MESSAGE;
      const inFlightRunText = process.env.OPENCLAW_TUI_PTY_IN_FLIGHT_TEXT;
      const dynamicCommandDescription = process.env.OPENCLAW_TUI_PTY_DYNAMIC_COMMAND_DESCRIPTION;
      const thinkingLabel = process.env.OPENCLAW_TUI_PTY_THINKING_LABEL;
      const safeThinkingLabel = process.env.OPENCLAW_TUI_PTY_SAFE_THINKING_LABEL;
      ${TUI_PTY_FALLBACK_FIXTURE.variables}
      const thinkingLevels = [
        ...(thinkingLabel ? [{ id: "fixture-thinking", label: thinkingLabel }] : []),
        ...(safeThinkingLabel ? [{ id: "fixture-thinking-safe", label: safeThinkingLabel }] : []),
      ];
      ${TUI_PTY_RECONNECT_FIXTURE.variables}
      const enablePickerFixture = process.env.OPENCLAW_TUI_PTY_PICKER_FIXTURE === "1";
      const pickerModelValue = process.env.OPENCLAW_TUI_PTY_PICKER_MODEL_VALUE ?? "fixture-provider/fixture-model-2";
      const pickerModelName = process.env.OPENCLAW_TUI_PTY_PICKER_MODEL_NAME ?? "Fixture 2";
      const pickerSessionKey = process.env.OPENCLAW_TUI_PTY_PICKER_SESSION_KEY ?? "agent:main:picker-target";
      const pickerSessionTitle = process.env.OPENCLAW_TUI_PTY_PICKER_SESSION_TITLE;
      const pickerSessionPreview = process.env.OPENCLAW_TUI_PTY_PICKER_SESSION_PREVIEW;
      const pickerSessionDisplayName = process.env.OPENCLAW_TUI_PTY_PICKER_SESSION_DISPLAY_NAME ?? "Picker target";
      const initialPluginApprovalSessionKey = process.env.OPENCLAW_TUI_PTY_INITIAL_APPROVAL_SESSION_KEY;
      const xaiLimitError = '403 {"code":"The caller does not have permission to execute the specified operation","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}';
      let currentModel = footerModel ?? "fixture-provider/fixture-model";
      let currentThinkingLevel = footerThinkingLevel;
      let fastMode = false;
      function pluginApproval(sessionKey: string) {
        return {
          id: "plugin:skill-pty",
          request: {
            title: "Apply workspace skill proposal",
            description: "Apply a pending workspace skill proposal into live workspace skills.",
            pluginId: "workspace-skills",
            severity: "warning" as const,
            toolName: "skill_workshop",
            allowedDecisions: ["allow-once", "deny"],
            sessionKey,
          },
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 120_000,
        };
      }
      let pendingPluginApproval: ReturnType<typeof pluginApproval> | null = initialPluginApprovalSessionKey
        ? pluginApproval(initialPluginApprovalSessionKey)
        : null;
      let pendingPluginApprovalRun: { runId: string; sessionKey: string } | null = null;
      ${TUI_PTY_TASK_FIXTURE.variables}

      function textReply(text: string) {
        return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() };
      }

      function sessionEntry(key = "main") {
        const isModeTarget = key.endsWith(":mode-target");
        const entryFastMode = isModeTarget ? undefined : fastMode;
        const entryVerboseLevel = isModeTarget ? undefined : verboseLevel;
        return {
          key,
          ...(isModeTarget ? {} : { displayName: key === pickerSessionKey ? pickerSessionDisplayName : "Main" }),
          model: currentModel,
          modelProvider: "fixture-provider",
          contextTokens: 128,
          ...(entryFastMode !== undefined ? { fastMode: entryFastMode } : {}),
          ...(currentThinkingLevel ? { thinkingLevel: currentThinkingLevel } : {}),
          ...(entryVerboseLevel ? { verboseLevel: entryVerboseLevel } : {}),
          thinkingLevels,
        };
      }

      ${TUI_PTY_STARTUP_SESSION_FIXTURE.sessionInventory}

      ${TUI_PTY_GAP_HISTORY_FIXTURE_SCRIPT}
      ${TUI_PTY_ASSISTANT_FIXTURE_SCRIPT}
      ${TUI_PTY_RENDERING_FIXTURE_SCRIPT}

      class FixtureBackend implements TuiBackend {
        connection = { url: "pty-fixture://local" };
        onEvent?: TuiBackend["onEvent"];
        onConnected?: TuiBackend["onConnected"];
        onDisconnected?: TuiBackend["onDisconnected"];
        onGap?: TuiBackend["onGap"];

        emit(event: string, payload: unknown) {
          this.onEvent?.({ event, payload });
        }

        ${TUI_PTY_RECONNECT_FIXTURE.disconnect}

        start() {
          if (pendingPluginApproval) {
            this.emit("plugin.approval.requested", pendingPluginApproval);
          }
          queueMicrotask(() => this.onConnected?.());
        }

        stop() {
          record("stop");
        }

        ${TUI_PTY_SESSION_SUBSCRIPTION_FIXTURE_SCRIPT}

        async sendChat(opts: Parameters<TuiBackend["sendChat"]>[0]) {
          record("sendChat", opts);
          const runId = opts.runId ?? "run-pty-fixture";
          const emitChat = (payload: Record<string, unknown>) =>
            this.emit("chat", { runId, sessionKey: opts.sessionKey, ...payload });
          ${TUI_PTY_RECONNECT_FIXTURE.sendChat}
          ${TUI_PTY_FALLBACK_FIXTURE.sendChat}
          if (opts.message === "tui error redaction proof") {
            const escape = String.fromCharCode(27);
            throw new Error("gateway down", {
              cause: new Error(escape + "[31mAuthorization: Bearer sk-abcdefghijklmnopqrstuv" + escape + "[0m"),
            });
          }
          if (startRenderingFixture(this, opts.message, runId, opts.sessionKey)) return { runId };
          if (opts.message === "/btw picker focus proof") {
            queueMicrotask(() => {
              record("pickerSideResult", { runId, sessionKey: opts.sessionKey });
              this.emit("chat.side_result", {
                kind: "btw",
                runId,
                sessionKey: opts.sessionKey,
                question: process.env.OPENCLAW_TUI_PTY_BTW_QUESTION ?? "picker focus proof",
                text: "PTY_SIDE_OK",
              });
              emitChat({ state: "final" });
            });
            return { runId };
          }
          if (opts.message === "history gap proof") { return beginGapHistoryRecovery(this, runId, opts.sessionKey); }
          if (opts.message === "skill approval proof" || opts.message === "skill approval gap proof") {
            pendingPluginApproval = pluginApproval(opts.sessionKey);
            pendingPluginApprovalRun = { runId, sessionKey: opts.sessionKey };
            queueMicrotask(() => {
              if (opts.message === "skill approval gap proof") {
                this.onGap?.({ expected: 4, received: 5 });
              } else {
                this.emit("plugin.approval.requested", pendingPluginApproval);
              }
            });
            return { runId };
          }
          if (opts.message === "task suggestion proof") {
            pendingTaskSuggestion = {
              id: "task_pty",
              title: "Remove stale adapter",
              prompt: "Delete the stale adapter and update its tests.",
              tldr: "The adapter is unreachable and adds maintenance cost.",
              cwd: "/repo/project",
              sessionKey: opts.sessionKey,
              agentId: "main",
              createdAt: Date.now(),
            };
            queueMicrotask(() => {
              this.emit("task.suggestion", { action: "created", suggestion: pendingTaskSuggestion });
            });
            return { runId };
          }
          const responseDelayMs = opts.message === "slow prompt" ? 500 : 20;
          setTimeout(() => {
            if (opts.message === "xai limit proof" || opts.message === "provider failure proof") {
              emitChat({
                seq: 0,
                state: "error",
                errorMessage: opts.message === "xai limit proof" ? xaiLimitError : "fixture provider failed",
              });
              return;
            }
            const attachmentOnlyMessage = buildAttachmentOnlyAssistantMessage(opts.message, runId);
            const message = attachmentOnlyMessage ?? textReply("PTY_RESPONSE: " + opts.message);
            emitChat({ state: "final", message });
          }, responseDelayMs);
          return { runId };
        }

        async abortChat(opts: Parameters<TuiBackend["abortChat"]>[0]) {
          record("abortChat", opts);
          return { ok: true, aborted: true };
        }

        async loadHistory(opts: Parameters<TuiBackend["loadHistory"]>[0]) {
          const sessionKey = opts?.sessionKey ?? "main";
          record("loadHistory", { sessionKey });
          const gapHistory = loadGapHistory(sessionKey);
          if (gapHistory) { return gapHistory; }
          ${TUI_PTY_RECONNECT_FIXTURE.loadHistory}
          ${TUI_PTY_STARTUP_SESSION_FIXTURE.loadHistory}
          const delayMs = startupDelayMs;
          ${TUI_PTY_STARTUP_SESSION_FIXTURE.historyBarrier}
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          const includeSessionInfo =
            Boolean(footerModel) || sessionKey.endsWith(":mode-target");
          return {
            messages: [],
            fastMode,
            ...(inFlightRunText
              ? { inFlightRun: { runId: "run-restored-in-flight", text: inFlightRunText } }
              : {}),
            ...(includeSessionInfo
              ? {
                  thinkingLevel: footerThinkingLevel,
                  sessionInfo: sessionEntry(sessionKey),
                }
              : {}),
          };
        }

        async describeSession(opts: Parameters<TuiBackend["describeSession"]>[0]) {
          record("describeSession", opts);
          ${TUI_PTY_STARTUP_SESSION_FIXTURE.describeSessionDelay}
          const session = fixtureSessions().find(({ key }) =>
            key === opts.sessionKey || ("agent:main:" + key) === opts.sessionKey,
          );
          return { session: session ?? null, defaults: sessionDefaults() };
        }

        async listSessions(opts?: Parameters<TuiBackend["listSessions"]>[0]) {
          record("listSessions", {
            ...opts,
            purpose: opts?.includeDerivedTitles ? "picker" : "refresh",
          });
          const sessions = fixtureSessions().filter((session) =>
            (session.key !== "global" || opts?.includeGlobal === true) &&
            (session.key !== "unknown" || opts?.includeUnknown === true) &&
            (!opts?.search || session.key.includes(opts.search) || session.label?.includes(opts.search)),
          ).slice(0, opts?.limit);
          return {
            ts: Date.now(),
            path: "",
            count: sessions.length,
            sessions,
            defaults: sessionDefaults(),
          };
        }

        async listAgents() {
          return {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main", name: enablePickerFixture ? pickerSessionDisplayName : "Main" }],
          };
        }

        async patchSession(opts: Parameters<TuiBackend["patchSession"]>[0]) {
          record("patchSession", opts);
          const releasePath = process.env.OPENCLAW_TUI_PTY_PATCH_RELEASE_PATH;
          while (releasePath && !existsSync(releasePath)) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          if (opts.model) {
            currentModel = opts.model;
          }
          if (opts.thinkingLevel) {
            currentThinkingLevel = opts.thinkingLevel;
          }
          if (typeof opts.fastMode === "boolean") {
            fastMode = opts.fastMode;
          }
          if (typeof opts.verboseLevel === "string") {
            verboseLevel = opts.verboseLevel;
          }
          return {
            ok: true,
            path: "",
            key: opts.key,
            entry: sessionEntry(opts.key),
            resolved: {
              modelProvider: "fixture-provider",
              model: currentModel,
            },
          };
        }

        async createSession(opts: Parameters<TuiBackend["createSession"]>[0]) {
          record("createSession", opts);
          const key = "agent:main:" + opts.key;
          return { ok: true, key, entry: { ...sessionEntry(key), sessionId: "created-session" } };
        }

        ${TUI_PTY_RESET_FIXTURE.methods}

        async getGatewayStatus() {
          record("getGatewayStatus");
          ${TUI_PTY_FALLBACK_FIXTURE.getGatewayStatus}
          this.reconnectSessionSubscription();
          this.emitDisconnect();
          return gatewayStatus;
        }

        async listModels() {
          record("listModels");
          return [
            { id: "fixture-provider/fixture-model", name: "Fixture", provider: "fixture-provider" },
            { id: pickerModelValue, name: pickerModelName, provider: "fixture-provider" },
          ];
        }

        async listCommands() {
          record("listCommands");
          return dynamicCommandDescription
            ? [{
                name: "t08dynamic",
                textAliases: ["/t08dynamic"],
                description: dynamicCommandDescription,
                source: "plugin" as const,
                scope: "text" as const,
                acceptsArgs: false,
              }]
            : [];
        }

        async listPluginApprovals() {
          record("listPluginApprovals", { pending: Boolean(pendingPluginApproval) });
          return pendingPluginApproval ? [pendingPluginApproval] : [];
        }

        async resolvePluginApproval(id: string, decision: "allow-once" | "allow-always" | "deny") {
          record("resolvePluginApproval", { id, decision });
          const pendingRun = pendingPluginApprovalRun;
          pendingPluginApproval = null;
          pendingPluginApprovalRun = null;
          this.emit("plugin.approval.resolved", { id, decision });
          this.emit("chat", {
            runId: pendingRun?.runId ?? "run-pty-fixture",
            sessionKey: pendingRun?.sessionKey ?? "agent:main:main",
            state: "final",
            message: textReply("PTY_SKILL_APPROVAL_RESOLVED: " + decision),
          });
          return { ok: true };
        }

        ${TUI_PTY_TASK_FIXTURE.methods}
      }

      async function main() {
        await runTui({
          backend: new FixtureBackend(),
          config: {
            agents: {
              defaults: { model: "fixture-provider/fixture-model" },
              entries: { main: {} },
            },
            session: { scope: "per-sender", mainKey: "main" },
          },
          deliver: process.env.OPENCLAW_TUI_PTY_DELIVER === "1",
          session: process.env.OPENCLAW_TUI_PTY_SESSION,
          thinking: launchThinkingLevel,
          message: initialMessage,
          historyLimit: 5,
          title: "openclaw tui pty fixture",
          ${TUI_PTY_RESET_FIXTURE.options}
        });
        ${TUI_PTY_STARTUP_SESSION_FIXTURE.returnedState}
      }

      main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `;
  await writeFile(
    scriptPath,
    prepared ? (await transform(source, { loader: "ts", format: "esm" })).code : source,
    "utf8",
  );
  return scriptPath;
}
