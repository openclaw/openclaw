import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { bindSessionMcpRuntimeTestScheduler } from "../../agents/agent-bundle-mcp-manager.test-support.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createFollowupRunner } from "./followup-runner.js";
import { enqueueFollowupRun } from "./queue.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const startup = vi.hoisted(() => vi.fn());
// mock-isolation: Fail at harness startup; queue admission, writer claim, settlement and delivery stay real.
vi.mock("../../agents/embedded-agent-runner/run/attempt-session-runtime-prepare.js", () => ({
  prepareEmbeddedAttemptSessionRuntime: startup,
}));

const state = await createOpenClawTestState({ label: "followup-writer-failure" });
afterAll(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  await state.cleanup();
});

it.each(["failure", "cancellation"] as const)(
  "settles queued startup %s against its claimed writer without replay",
  async (mode) => {
    startup.mockReset();
    const sessionKey = "agent:main:writer-failure";
    const sessionId = "writer-failure-session";
    const storePath = path.join(state.sessionsDir(), "openclaw-agent.sqlite");
    const scope = { agentId: "main", storePath, sessionKey };
    const cfg: OpenClawConfig = {
      session: { store: storePath },
      agents: {
        entries: { main: { workspace: state.workspaceDir, agentDir: state.agentDir() } },
        defaults: {
          model: "proof/model",
          models: { "proof/model": { agentRuntime: { id: "openclaw" } } },
          sandbox: { mode: "off" },
          skipBootstrap: true,
        },
      },
      models: {
        providers: {
          proof: {
            api: "openai-completions",
            apiKey: "synthetic-proof-key",
            baseUrl: "http://127.0.0.1:1/v1",
            models: [
              {
                id: "model",
                name: "Proof model",
                reasoning: false,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      plugins: { slots: { memory: "none" } },
      skills: { load: { watch: false } },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await bindSessionMcpRuntimeTestScheduler();
    await replaceSessionEntry(scope, {
      sessionId,
      lifecycleRevision: "original-lifecycle",
      activeWriterRunId: "prior-run",
      updatedAt: 1,
    });
    const deliver = vi.fn(async () => {});
    const failure =
      mode === "cancellation"
        ? createAgentRunDirectAbortError()
        : new AgentHarnessPreflightError("synthetic harness startup failed", {
            userMessage: "Synthetic harness startup failed. Try again.",
          });
    startup.mockImplementation(async () => {
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId,
        lifecycleRevision: "original-lifecycle",
      });
      expect(loadSessionEntry(scope)?.activeWriterRunId).not.toBe("prior-run");
      throw failure;
    });
    const queued = createMockFollowupRun({
      prompt: "Run the queued request",
      originatingChannel: "webchat",
      queuedFollowupReplyDisposition: { kind: "deliver", deliver },
      run: {
        agentId: "main",
        sessionId,
        sessionKey,
        config: cfg,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        provider: "proof",
        model: "model",
        messageProvider: "webchat",
        verboseLevel: "on",
        thinkingCatalog: [{ provider: "proof", id: "model", input: ["text"] }],
      },
    });
    const runner = createFollowupRunner({
      storePath,
      sessionKey,
      sessionEntry: loadSessionEntry(scope),
      defaultModel: "proof/model",
      typing: createMockTypingController(),
      typingMode: "never",
    });
    const completed = createDeferred();
    expect(
      enqueueFollowupRun(
        sessionKey,
        queued,
        { mode: "followup", debounceMs: 0 },
        "none",
        async (run) => {
          try {
            await runner(run);
            completed.resolve();
          } catch (error) {
            completed.reject(error);
          }
        },
      ),
    ).toBe(true);
    await completed.promise;
    expect(startup).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(
        mode === "cancellation"
          ? {
              payloads: [],
              completion: expect.objectContaining({ kind: "aborted" }),
            }
          : {
              payloads: [
                expect.objectContaining({
                  text: expect.stringContaining("Synthetic harness startup failed. Try again."),
                }),
              ],
              completion: expect.objectContaining({
                kind: "failed",
                error: expect.stringContaining("Synthetic harness startup failed. Try again."),
              }),
            },
      ),
    );
  },
);
