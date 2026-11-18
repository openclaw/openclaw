import { afterAll, afterEach, assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as runs from "../../agents/admitted-run-context.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as terminal from "../../infra/agent-run-terminal-writes.js";
import type { ReplyBackendHandle } from "../../sessions/session-controller.contracts.js";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.lifecycle.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createConsultRunner } from "./client-gateway-control.agent-consult-fixture.test-support.js";
import { prepareTalkSessionTarget } from "./session-target.js";

const core = vi.hoisted(() => vi.fn<typeof runEmbeddedAgent>());
// mock-isolation: Exercise real Talk admission and terminal custody without starting a model runtime.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: core }));

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let config: OpenClawConfig;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "talk-terminal-writes" });
  config = { agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } } };
  await state.writeConfig(config);
});
beforeEach(() => setRuntimeConfigSnapshot(config));
afterEach(() => {
  core.mockReset();
  clearRuntimeConfigSnapshot();
});
afterAll(async () => state?.cleanup());

function prepareCliConsult(beforeEffect?: (effect: () => void) => Promise<void>) {
  const entered =
    createDeferred<NonNullable<ReturnType<typeof getCurrentSessionControllerOwner>>>();
  const finish = createDeferred();
  const injected: string[] = [];
  core.mockImplementationOnce(async (params) => {
    const admittedRunContext = await runs.resolvePreparedRunAdmission({
      ...params,
      runtimeKind: "embedded",
    });
    const operation = getCurrentSessionControllerOwner();
    assert(operation);
    return await withGatewayToolCallerIdentity(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext,
        agentId: operation.agentId,
        sessionKey: operation.key,
      }),
      async () => {
        const lifecycle = createDeferredEmbeddedRunLifecycleManager({
          replyOperation: operation,
          runId: params.runId,
          sessionId: operation.sessionId,
          sessionKey: operation.key,
          agentId: operation.agentId,
          abortSignal: params.abortSignal,
        });
        try {
          lifecycle.handoffToCli();
          await operation.bindToolAuthoritySnapshotAsync({
            fingerprint: () => "talk-cli-policy",
            fingerprintAsync: async () => "talk-cli-policy",
            project: () => "talk-cli-policy",
            projectAsync: async () => "talk-cli-policy",
          });
          await operation.bindToolAuthorityRouteAsync({ provider: "synthetic", model: "talk-cli" });
          operation.attachBackend({
            kind: "cli",
            runId: params.runId,
            cancel() {},
            messageInjectionV2: {
              version: 2,
              isAvailable: () => true,
              async queueMessage() {
                throw new Error("CLI steering requires prepared injection");
              },
              async queueMessageAsync(text, options, preparation) {
                await preparation.prepareCurrent();
                const effect = () => {
                  preparation.assertCurrent();
                  injected.push(text);
                  options?.onQueueAccepted?.(true);
                };
                await beforeEffect?.(effect);
                effect();
              },
            },
          } satisfies ReplyBackendHandle);
          entered.resolve(operation);
          await finish.promise;
          return { payloads: [{ text: "Answer" }], meta: { durationMs: 0 } };
        } finally {
          await lifecycle.complete();
        }
      },
    );
  });
  return { entered: entered.promise, finish: finish.resolve, injected };
}

it.for([false, true])(
  "steers the admitted CLI consult without embedded authority (session rotated: %s)",
  async (rotate, { signal }) => {
    const execution = prepareCliConsult();
    const runner = createConsultRunner({
      config,
      ownerConnId: `talk-cli-${rotate}`,
      sessionTarget: await prepareTalkSessionTarget(config, `agent:main:talk-cli-${rotate}`),
    });
    runner.runPrompt.adoptCompletionClaims();
    const run = runner.runPrompt({ prompt: "check" });
    try {
      const operation = await withinTest(
        awaitGateBeforeSettlement(execution.entered, run, "Talk must reach the CLI backend"),
        signal,
      );
      if (rotate) {
        operation.updateSessionId("talk-cli-rotated");
      }
      assert(runner.runPrompt.steer);
      await expect(
        withinTest(runner.runPrompt.steer({ prompt: "Use the revised plan" }), signal),
      ).resolves.toEqual({ text: "" });
      expect(execution.injected).toEqual(["Use the revised plan"]);
    } finally {
      execution.finish();
      await run;
      runner.runPrompt.claimFailureAppend();
    }
  },
);

it("revokes a retained CLI injection callback after its consult is replaced", async ({
  signal,
}) => {
  let retainedEffect: (() => void) | undefined;
  const oldExecution = prepareCliConsult(async (effect) => {
    retainedEffect = effect;
    // A refused transport can retain callbacks, but cannot retain their authority.
    throw new Error("CLI declined before enqueue");
  });
  const runner = createConsultRunner({
    config,
    ownerConnId: "talk-cli-replacement",
    sessionTarget: await prepareTalkSessionTarget(config, "agent:main:talk-cli-replacement"),
  });
  runner.runPrompt.adoptCompletionClaims();
  const oldRun = runner.runPrompt({ prompt: "old request" });
  let replacementRun: ReturnType<typeof runner.runPrompt> | undefined;
  let replacement: ReturnType<typeof prepareCliConsult> | undefined;
  try {
    await withinTest(
      awaitGateBeforeSettlement(oldExecution.entered, oldRun, "Talk must reach the CLI backend"),
      signal,
    );
    assert(runner.runPrompt.steer);
    await expect(
      withinTest(runner.runPrompt.steer({ prompt: "stale guidance" }), signal),
    ).rejects.toThrow();
    assert(retainedEffect);
    oldExecution.finish();
    await withinTest(oldRun, signal);
    runner.runPrompt.claimFailureAppend();
    replacement = prepareCliConsult();
    replacementRun = runner.runPrompt({ prompt: "replacement request" });
    await withinTest(
      awaitGateBeforeSettlement(
        replacement.entered,
        replacementRun,
        "Replacement Talk must reach the CLI backend",
      ),
      signal,
    );
    expect(retainedEffect).toThrow();
    expect(oldExecution.injected).toEqual([]);
    expect(replacement.injected).toEqual([]);
    await expect(
      withinTest(runner.runPrompt.steer({ prompt: "current guidance" }), signal),
    ).resolves.toEqual({ text: "" });
    expect(replacement.injected).toEqual(["current guidance"]);
  } finally {
    oldExecution.finish();
    replacement?.finish();
    await Promise.allSettled([oldRun, replacementRun]);
    runner.runPrompt.claimFailureAppend();
  }
});

it("refreshes browser Talk activity through accepted user-turn storage", async () => {
  const sessionTarget = await prepareTalkSessionTarget(config, "agent:main:talk-idle");
  const scope = { ...sessionTarget, sessionKey: sessionTarget.canonicalKey };
  const now = Date.now();
  const staleAt = now - 61 * 60_000;
  await replaceSessionEntry(scope, {
    sessionId: "talk-idle",
    updatedAt: staleAt,
    lastInteractionAt: staleAt,
  });
  core.mockImplementation(async (params) => {
    await runs.resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
    assert(params.userTurnTranscriptRecorder);
    await params.userTurnTranscriptRecorder.persistApproved();
    return { payloads: [{ text: "Answer" }], meta: { durationMs: 0 } };
  });
  using _ = vi.spyOn(Date, "now").mockReturnValue(now);
  const runner = createConsultRunner({ config, sessionTarget });
  await expect(runner.runPrompt({ prompt: "check" })).resolves.toEqual({ text: "Answer" });
  expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "talk-idle", lastInteractionAt: now });
});

it.each([false, true])("drains writes; abort revokes authority (%s)", async (abort) => {
  const commit = createDeferred();
  const captured = createDeferred<{
    admitted: runs.AdmittedRunContext;
    writeContext: terminal.CapturedAgentRunTerminalWriteContext;
    persistence: Promise<void>;
  }>();
  core.mockImplementation(async (params) => {
    const admitted = await runs.resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
    const writeContext = terminal.captureAgentRunTerminalPersistence(params.runId).writeContext;
    assert(writeContext);
    const persistence = commit.promise.then(() => writeContext.run(() => {}));
    writeContext.track(persistence);
    captured.resolve({ admitted, writeContext, persistence });
    return { payloads: [{ text: "Answer" }], meta: { durationMs: 0 } };
  });
  const controller = new AbortController();
  const runner = createConsultRunner({
    config,
    sessionTarget: await prepareTalkSessionTarget(config, `agent:main:talk-terminal-${abort}`),
  });
  const settled = vi.fn();
  const run = runner.runPrompt({ prompt: "check", signal: controller.signal });
  void run.then(settled, settled);
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
      expect(runs.getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
    }
    expect(settled).not.toHaveBeenCalled();
    commit.resolve();
    await persistence;
    await (abort
      ? expect(run).rejects.toMatchObject({ name: "AbortError" })
      : expect(run).resolves.toEqual({ text: "Answer" }));
    expect(runs.getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
    expect(() => writeContext.run(() => writeContext.assertCurrent())).toThrow(
      "Terminal write owner changed before commit",
    );
  } finally {
    commit.resolve();
    await run.catch(() => undefined);
  }
});
