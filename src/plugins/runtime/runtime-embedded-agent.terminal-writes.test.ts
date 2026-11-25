import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  getAdmittedRunDelegatedAuthority,
  resolvePreparedRunAdmission,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import type { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import {
  captureAgentRunTerminalPersistence,
  type CapturedAgentRunTerminalWriteContext,
} from "../../infra/agent-run-terminal-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { runPluginEmbeddedAgent } from "./runtime-embedded-agent.runtime.js";

const core = vi.hoisted(() => vi.fn<typeof runEmbeddedAgent>());
// mock-isolation: Exercise real plugin admission and terminal custody without starting a model runtime.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: core }));

afterEach(() => core.mockReset());

const fixture = { scenario: "minimal", label: "plugin-terminal-writes" } as const;
it.each([false, true])("drains terminal writes (abort=%s)", async (abort) => {
  await withOpenClawTestState(fixture, async (state) => {
    const config = {
      agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
    };
    await state.writeConfig(config);
    const commit = createDeferred();
    const captured = createDeferred<{
      admitted: AdmittedRunContext;
      writeContext: CapturedAgentRunTerminalWriteContext;
      persistence: Promise<void>;
    }>();
    const result = { payloads: [{ text: "Answer" }], meta: { durationMs: 0 } };
    core.mockImplementation(async (params) => {
      const admitted = await resolvePreparedRunAdmission({
        ...params,
        runtimeKind: "embedded",
      });
      // Model the Gateway's terminal-session write during the runner's lifecycle event.
      const writeContext = captureAgentRunTerminalPersistence(params.runId).writeContext;
      assert(writeContext);
      const persistence = commit.promise.then(() =>
        writeContext.run(() => writeContext.assertCurrent()),
      );
      writeContext.track(persistence);
      captured.resolve({ admitted, writeContext, persistence });
      return result;
    });
    const controller = new AbortController();
    const sessionKey = `agent:main:plugin-terminal-${abort}`;
    let settled = false;
    const run = withPluginRuntimePluginScope({ pluginId: "terminal-writes-plugin" }, () =>
      runPluginEmbeddedAgent({
        config,
        prompt: "Check terminal bookkeeping",
        runId: `plugin-terminal-${abort}`,
        sessionId: `session-${abort}`,
        sessionKey,
        sessionTarget: {
          agentId: "main",
          sessionId: `session-${abort}`,
          sessionKey,
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        },
        timeoutMs: 1_000,
        workspaceDir: state.workspaceDir,
        abortSignal: controller.signal,
      }),
    );
    const markSettled = () => {
      settled = true;
    };
    void run.then(markSettled, markSettled);
    try {
      const { admitted, writeContext, persistence } = await awaitGateBeforeSettlement(
        captured.promise,
        run,
        "Plugin run must reach embedded execution",
      );
      // The wrapper registered its core continuation before this observer.
      await core.mock.results[0]?.value;
      if (abort) {
        controller.abort();
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
      }
      expect(settled).toBe(false);
      commit.resolve();
      await persistence;
      await expect(run).resolves.toBe(result);
      expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
      expect(() => writeContext.run(() => writeContext.assertCurrent())).toThrow(
        "Terminal write owner changed before commit",
      );
    } finally {
      commit.resolve();
      await run.catch(() => undefined);
    }
  });
});
