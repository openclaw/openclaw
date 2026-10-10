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
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTalkClientAgentConsultRunner } from "./client-agent-consult.js";

const core = vi.hoisted(() => vi.fn<typeof runEmbeddedAgent>());
// mock-isolation: Exercise real Talk admission and terminal custody without starting a model runtime.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: core }));

let state: OpenClawTestState;
let config: OpenClawConfig;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "talk-terminal-writes" });
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
    core.mockImplementation(async (params) => {
      const admitted = await resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
      const writeContext = captureAgentRunTerminalWriteContext(params.runId);
      assert(writeContext);
      const persistence = commit.promise.then(() =>
        writeContext.run(() => writeContext.assertCurrent()),
      );
      writeContext.track(persistence);
      captured.resolve({ admitted, writeContext, persistence });
      return { payloads: [{ text: "Answer" }], meta: { durationMs: 0 } };
    });
    const controller = new AbortController();
    const sessionKey = `agent:main:talk-terminal-${abort}`;
    const runner = createTalkClientAgentConsultRunner({
      config,
      context: {
        chatAbortControllers: new Map(),
        logGateway: createSubsystemLogger("test/talk-terminal-writes"),
      },
      sessionTarget: {
        agentId: "main",
        sessionKey,
        canonicalKey: sessionKey,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      },
      getVoiceSessionId: () => "voice-session",
      initialItems: [],
      registerRun: async () => ({ release: () => {}, isCurrent: () => true }),
    });
    let settled = false;
    const run = runner.runPrompt({
      prompt: "Check terminal bookkeeping",
      signal: controller.signal,
    });
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
        "Talk must reach embedded execution",
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
        await expect(run).rejects.toMatchObject({ name: "AbortError" });
      } else {
        expect(settled).toBe(false);
        commit.resolve();
        await persistence;
        await expect(run).resolves.toEqual({ text: "Answer" });
      }
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
