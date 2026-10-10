import path from "node:path";
import { afterAll, afterEach, assert, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  getAdmittedRunDelegatedAuthority,
  resolvePreparedRunAdmission,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import type { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureAgentRunTerminalWriteContext,
  type CapturedAgentRunTerminalWriteContext,
} from "../../infra/agent-run-terminal-writes.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { runPluginEmbeddedAgent } from "./runtime-embedded-agent.runtime.js";

const core = vi.hoisted(() => vi.fn<typeof runEmbeddedAgent>());
// mock-isolation: Exercise real plugin admission and terminal custody without starting a model runtime.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: core }));

let state: OpenClawTestState;
let config: OpenClawConfig;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "plugin-terminal-writes" });
  config = { agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } } };
  await state.writeConfig(config);
});
afterEach(() => core.mockReset());
afterAll(async () => state?.cleanup());

it.each([false, true])(
  "settles terminal writes before normal close while abort stays immediate (abort=%s)",
  async (abort) => {
    const commit = createDeferred();
    const captured = createDeferred<{
      admitted: AdmittedRunContext;
      writeContext: CapturedAgentRunTerminalWriteContext;
      persistence: Promise<void>;
    }>();
    const result = { payloads: [{ text: "Answer" }], meta: { durationMs: 0 } };
    core.mockImplementation(async (params) => {
      const admitted = await resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
      // The Gateway captures and tracks the terminal session write while the
      // run's terminal lifecycle event is dispatched inside the runner.
      const writeContext = captureAgentRunTerminalWriteContext(params.runId);
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
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
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
        expect(() => writeContext.run(() => writeContext.assertCurrent())).toThrow(
          "Terminal write owner changed before commit",
        );
        commit.resolve();
        await expect(persistence).rejects.toThrow("Terminal write owner changed before commit");
      } else {
        const settledBeforeCommit = settled;
        commit.resolve();
        await persistence;
        expect(settledBeforeCommit).toBe(false);
      }
      await expect(run).resolves.toBe(result);
      expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
      expect(() => writeContext.run(() => writeContext.assertCurrent())).toThrow(
        "Terminal write owner changed before commit",
      );
    } finally {
      commit.resolve();
      await run.catch(() => undefined);
    }
  },
);
