import { describe, expect, it, vi } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createHookRunner } from "./hooks.js";
import type { PluginHookRegistration } from "./hook-types.js";

function createRegistry(hooks: PluginHookRegistration[]) {
  return {
    hooks: [],
    typedHooks: hooks,
    plugins: hooks.map((hook) => ({ id: hook.pluginId, status: "loaded" as const })),
  };
}

describe("post-turn durable hook execution", () => {
  it("records a completed job for each high-risk post-turn hook handler", async () => {
    await withStateDirEnv("openclaw-hooks-post-turn-", async () => {
      const { readPostTurnJobState } = await import("../agents/post-turn/durable-job-state.js");
      const handler = vi.fn(async () => undefined);
      const runner = createHookRunner(
        createRegistry([
          {
            pluginId: "memory-plugin",
            hookName: "agent_end",
            handler,
            source: "test",
          },
        ]),
      );

      await runner.runAgentEnd(
        { messages: [], success: true, durationMs: 12 },
        { runId: "run-1", agentId: "main", sessionId: "session-1" },
      );

      expect(handler).toHaveBeenCalledTimes(1);
      expect((await readPostTurnJobState()).jobs).toEqual([
        expect.objectContaining({
          kind: "plugin_hook",
          hookName: "agent_end",
          pluginId: "memory-plugin",
          runId: "run-1",
          sessionId: "session-1",
          status: "completed",
        }),
      ]);
    });
  });

  it("skips a matching hook when the crash circuit breaker is open", async () => {
    await withStateDirEnv("openclaw-hooks-post-turn-", async () => {
      const { createPostTurnJob, markPostTurnJobCrashed, readPostTurnJobState } = await import(
        "../agents/post-turn/durable-job-state.js"
      );
      const handler = vi.fn(async () => undefined);
      const crashed = await createPostTurnJob({
        kind: "plugin_hook",
        hookName: "llm_output",
        pluginId: "memory-plugin",
        label: "llm_output hook",
      });
      await markPostTurnJobCrashed(crashed.id, {
        reason: "stale running post-turn job after restart",
      });

      const runner = createHookRunner(
        createRegistry([
          {
            pluginId: "memory-plugin",
            hookName: "llm_output",
            handler,
            source: "test",
          },
        ]),
      );

      await runner.runLlmOutput(
        {
          runId: "run-1",
          sessionId: "session-1",
          provider: "test",
          model: "test",
          resolvedRef: "test/test",
          assistantTexts: ["ok"],
        },
        { runId: "run-1", agentId: "main", sessionId: "session-1" },
      );

      expect(handler).not.toHaveBeenCalled();
      expect((await readPostTurnJobState()).jobs.at(-1)).toMatchObject({
        kind: "plugin_hook",
        hookName: "llm_output",
        pluginId: "memory-plugin",
        status: "skipped",
      });
    });
  });
});
