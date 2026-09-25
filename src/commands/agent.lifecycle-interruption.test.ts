// Lifecycle interruption semantics for the run-level agent command admission.
// Restart classification is opt-in: an untyped interruption is what a queued
// message taking over, a reset, a rollover drain or a placement move sends, and
// recording one as a restart leaves the durable row `running` + `abortedLastRun`
// -- the pair main-session restart recovery admits on.
import path from "node:path";
import { withTempHome as withTempHomeBase } from "openclaw/plugin-sdk/test-env";
import "./agent-command.test-mocks.js";
import "./agent-command-attempt.test-mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  isAgentRunDirectAbortReason,
  isAgentRunRestartAbortReason,
  resolveAgentRunAbortLifecycleFields,
} from "../agents/run-termination.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { GatewayDrainingError } from "../process/gateway-work-admission.js";
import { interruptSessionWorkAdmissions } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { agentCommandFromIngress } from "./agent.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const configIoMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: configIoMocks.loadConfig,
  loadConfig: configIoMocks.loadConfig,
  readConfigFileSnapshotForWrite: configIoMocks.readConfigFileSnapshotForWrite,
}));

const runtime = createThrowingTestRuntime();

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-interrupt-" });
}

function mockConfig(home: string, storePath: string) {
  configIoMocks.loadConfig.mockReturnValue({
    meta: { migrations: { modelPolicyAllowlist: true } },
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig);
}

async function writeSessionStoreSeed(
  storePath: string,
  sessions: Record<string, { sessionId: string; updatedAt: number }>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(sessions)) {
    await replaceSessionEntry({ sessionKey, storePath }, entry as SessionEntry);
  }
}

function createDefaultAgentResult() {
  return {
    payloads: [{ text: "ok" }],
    meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest();
  vi.mocked(runEmbeddedAgent).mockResolvedValue(createDefaultAgentResult());
});

describe("agentCommand lifecycle interruption", () => {
  // Restart classification is opt-in. A generic (untyped) lifecycle
  // interruption is what a queued message taking over, a reset, a rollover
  // drain or a placement move sends; classifying it as a restart leaves the
  // durable row running + abortedLastRun and dispatches a bogus main-session
  // restart recovery on the next turn.
  it.each(["generic", "explicit restart", "gateway drain", "terminal Stop"] as const)(
    "preserves lifecycle interruption semantics: %s",
    async (interruption) => {
      const restartDisposition =
        interruption === "explicit restart" || interruption === "gateway drain";
      await withTempHome(async (home) => {
        const store = path.join(home, "sessions.json");
        const sessionKey = "agent:main:subagent:lifecycle-restart";
        const sessionId = "lifecycle-restart-session-id";
        mockConfig(home, store);
        await writeSessionStoreSeed(store, {
          [sessionKey]: { sessionId, updatedAt: Date.now() },
        });
        let observedAbortReason: unknown;
        const entered = createDeferredCore();
        const cleanup = new AbortController();
        const reason =
          interruption === "terminal Stop"
            ? createAgentRunDirectAbortError()
            : interruption === "explicit restart"
              ? createAgentRunRestartAbortError()
              : interruption === "gateway drain"
                ? new GatewayDrainingError("gateway is draining for restart")
                : undefined;
        vi.mocked(runEmbeddedAgent).mockImplementationOnce(
          async (opts) =>
            await new Promise((resolve) => {
              entered.resolve();
              const finish = () => {
                observedAbortReason = opts.abortSignal?.reason;
                resolve(createDefaultAgentResult());
              };
              if (opts.abortSignal?.aborted) {
                finish();
                return;
              }
              opts.abortSignal?.addEventListener("abort", finish, { once: true });
            }),
        );

        const command = agentCommandFromIngress(
          {
            message: "interrupt this lifecycle run",
            sessionId,
            allowModelOverride: false,
            abortSignal: cleanup.signal,
          },
          runtime,
        ).catch((error: unknown) => error);
        try {
          await Promise.race([
            entered.promise,
            command.then((result) => {
              throw new Error("Command settled before embedded entry", { cause: result });
            }),
          ]);
          expect(runEmbeddedAgent).toHaveBeenCalledOnce();
          await interruptSessionWorkAdmissions({
            scope: store,
            identities: [sessionKey, sessionId],
            reason,
          });
          const commandResult = await command;
          if (interruption === "terminal Stop") {
            expect(observedAbortReason).toBe(reason);
            expect(isAgentRunDirectAbortReason(observedAbortReason)).toBe(true);
          }
          expect(isAgentRunRestartAbortReason(observedAbortReason)).toBe(restartDisposition);
          expect(isAgentRunRestartAbortReason(commandResult)).toBe(restartDisposition);
          if (interruption === "generic") {
            // An untyped interruption ends the run as an ordinary abort, which
            // the durable row records as `killed` — not the running +
            // abortedLastRun pair restart recovery admits on.
            expect(
              resolveAgentRunAbortLifecycleFields(AbortSignal.abort(observedAbortReason as Error))
                .stopReason,
            ).toBe("aborted");
          }
        } finally {
          cleanup.abort(createAgentRunDirectAbortError());
          await command;
        }
      });
    },
  );
});
