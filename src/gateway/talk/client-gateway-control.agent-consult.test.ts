import { copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { ReplyToolAuthorityOverlay } from "../../sessions/session-controller.contracts.js";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureClientVoiceSessionSource } from "../../talk/client-voice-session-source.js";
import { readVoiceSessionRecord } from "../../talk/client-voice-session-store.js";
import { createOrResumeClientVoiceSession } from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { setTestEnvValue } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";

const { coreParams, deferred, mocks } = await vi.hoisted(
  () => import("./client-gateway-control.agent-consult.test-support.js"),
);

vi.mock("../../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
vi.mock("../../talk/agent-consult-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/agent-consult-runtime.js")>()),
  consultRealtimeVoiceAgent: mocks.consultRealtimeVoiceAgent,
}));
vi.mock("../../talk/agent-run-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/agent-run-control.js")>()),
  controlRealtimeVoiceAgentRun: mocks.controlRealtimeVoiceAgentRun,
}));

import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import {
  createConsultRunner,
  createRunner,
  resetConsultFixture,
} from "./client-gateway-control.agent-consult-fixture.test-support.js";
import type { ConsultParams } from "./client-gateway-control.agent-consult.test-support.js";
import { resolveTalkAgentConsultAuthority } from "./client-gateway-control.js";

type ConsultOverrides = Parameters<typeof createConsultRunner>[0];
type ControlParams = Parameters<
  typeof import("../../talk/agent-run-control.js").controlRealtimeVoiceAgentRun
>[0];
const cleanups: Array<() => void> = [];
const finalizers: Array<() => void> = [];
const pendingRuns: Promise<unknown>[] = [];
function gate() {
  const value = deferred<void>();
  cleanups.push(() => value.resolve());
  return value;
}
function track<T>(run: Promise<T>) {
  pendingRuns.push(run);
  void run.catch(() => {});
  return run;
}
function createOwnedRunner(overrides: ConsultOverrides = {}) {
  return createConsultRunner({ ownerConnId: "connection-owner", ...overrides });
}

function startOwnedConsult(overrides: ConsultOverrides = {}) {
  const runner = createOwnedRunner(overrides);
  runner.runPrompt.adoptCompletionClaims();
  finalizers.push(() => runner.runPrompt.claimFailureAppend());
  return { runner, run: track(runner.runPrompt({ prompt: "first task" })) };
}

const announce = (params: ConsultParams, timeoutMs = 60_000) =>
  params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs });

function expectClaimOnce(claim: () => boolean) {
  expect(claim()).toBe(true);
  expect(claim()).toBe(false);
}

async function projectSteering(params: ControlParams) {
  const overlay = params.getToolAuthorityOverlay?.();
  if (overlay) {
    await params.prepareToolAuthorityOverlay?.(overlay);
  }
  return { ok: true, queued: true, message: "Steering accepted." };
}

function pendingBackend(
  instanceId: string,
  handle: ReturnType<typeof createEmbeddedRunHandle>,
  publish: (instance: OperationalRunInstanceRef) => Promise<void> | void,
) {
  const finish = gate();
  const published = gate();
  const instance = { instanceId: `instance:${instanceId}`, runId: "run-talk" };
  mocks.createOperationalRunInstanceRef.mockReturnValueOnce(instance);
  mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
    await publish(instance);
    published.resolve();
    await finish.promise;
    clearActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk");
    return { payloads: [] };
  });
  return { finish, published };
}

function withBackendAuthority<T>(
  operationalRunInstance: OperationalRunInstanceRef,
  project: (overlay: ReplyToolAuthorityOverlay) => string,
  source: "reply" | "attempt",
  assertActive: () => void,
  run: (operation: NonNullable<ReturnType<typeof getCurrentSessionControllerOwner>>) => T,
) {
  return withGatewayToolCallerIdentity(
    {
      agentId: "researcher",
      sessionKey: "agent:researcher:talk",
      operationalRunInstance,
      embeddedRunToolAuthorityBinding: () => ({
        acceptsRequesterOrigin: () => false,
        source,
        project,
        projectAsync: async (overlay) => project(overlay),
        assertRegistrationActive: assertActive,
        assertActive,
      }),
    },
    () => {
      const operation = getCurrentSessionControllerOwner();
      if (!operation) {
        throw new Error("Talk consult has no controller-owned turn");
      }
      return run(operation);
    },
  );
}

function publishBackend(
  handle: ReturnType<typeof createEmbeddedRunHandle>,
  instance: OperationalRunInstanceRef,
  project: (overlay: ReplyToolAuthorityOverlay) => string,
  source: "reply" | "attempt",
  assertActive = () => {},
) {
  return withBackendAuthority(instance, project, source, assertActive, (operation) =>
    setActiveEmbeddedRun(
      "session-talk",
      handle,
      "agent:researcher:talk",
      undefined,
      "researcher",
      operation,
    ),
  );
}

describe("Talk client agent consult admission", () => {
  beforeEach(resetConsultFixture);

  afterEach(async () => {
    cleanups.splice(0).forEach((release) => release());
    await Promise.allSettled(pendingRuns.splice(0));
    finalizers.splice(0).forEach((finish) => finish());
    embeddedRunsTesting.resetActiveEmbeddedRuns();
  });

  it("does not advertise steering without a connection owner", () => {
    expect(createRunner().runPrompt).not.toHaveProperty("steer");
  });

  it.each(["success", "failure"] as const)(
    "keeps the released provider callback reusable after %s",
    async (outcome) => {
      if (outcome === "failure") {
        mocks.consultRealtimeVoiceAgent.mockRejectedValueOnce(new Error("consult failed"));
      }
      const runner = createRunner();
      const first = runner.runPrompt({ prompt: "first task" });
      if (outcome === "failure") {
        await expect(first).rejects.toThrow("consult failed");
      } else {
        await expect(first).resolves.toEqual({ text: "done" });
        expect(mocks.consultRealtimeVoiceAgent.mock.calls[0]?.[0]).toMatchObject({
          senderIsOwner: false,
          toolsAllow: ["read"],
        });
        expect(mocks.close).toHaveBeenCalledOnce();
      }
      await expect(runner.runPrompt({ prompt: "second task" })).resolves.toEqual({
        text: "done",
      });
    },
  );

  it.each(["runOwnedArgs", "runPrompt"] as const)(
    "steers and claims only the exact registered consult owner through %s",
    (entrypoint) =>
      withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const core = gate();
        const published = gate();
        const scope = {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          storePath: state.statePath("sessions.sqlite"),
        };
        const now = Date.now();
        const priorInteractionAt = now - 61 * 60_000;
        await replaceSessionEntry(scope, {
          sessionId: "session-talk",
          updatedAt: priorInteractionAt,
          lastInteractionAt: priorInteractionAt,
        });
        rpcSourceTesting.clear();
        const isRunCurrent = vi.fn((runId: string) => runId === "run-talk");
        const operationalRunInstance = {
          instanceId: `instance:${entrypoint}`,
          runId: "run-talk",
        };
        mocks.createOperationalRunInstanceRef.mockReturnValueOnce(operationalRunInstance);
        mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
          await announce(params);
          await params.agentRuntime.runEmbeddedAgent({
            ...coreParams,
            sessionTarget: { ...scope, sessionId: "session-talk" },
          });
          return { text: "done" };
        });
        mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
          const handle = createEmbeddedRunHandle({ runId: "run-talk" });
          await publishBackend(handle, operationalRunInstance, () => "authority", "attempt");
          published.resolve();
          await core.promise;
          clearActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk");
          return { payloads: [] };
        });
        const runner = createOwnedRunner({
          sessionTarget: { ...scope, canonicalKey: scope.sessionKey, assertCurrent: () => {} },
          registerRun: vi.fn(async ({ runId }) => ({
            release: vi.fn(),
            isCurrent: () => isRunCurrent(runId),
          })),
        });

        const lifecycleRunner = runner[entrypoint];
        if (entrypoint === "runPrompt") {
          runner.runPrompt.adoptCompletionClaims();
        }
        const run =
          entrypoint === "runOwnedArgs"
            ? runner.runOwnedArgs({ question: "first task" }, new AbortController().signal)
            : runner.runPrompt({ prompt: "first task" });
        mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(async (params: ControlParams) => {
          const recorder = params.createUserTurnTranscriptRecorder?.(params.text);
          if (entrypoint === "runPrompt") {
            expect(recorder).toBeDefined();
            await recorder!.persistApproved();
          } else {
            expect(recorder).toBeUndefined();
          }
          return { ok: true, queued: true, message: "Steering accepted." };
        });
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        try {
          await awaitGateBeforeSettlement(published.promise, run, "Talk backend must register");
          const steer = lifecycleRunner.steer;
          if (!steer) {
            throw new Error("owned Talk runner did not expose steering");
          }
          await steer({ prompt: "latest task" });
          expect(loadSessionEntry(scope)?.lastInteractionAt).toBe(
            entrypoint === "runPrompt" ? now : priorInteractionAt,
          );

          expect(mocks.controlRealtimeVoiceAgentRun).toHaveBeenCalledWith(
            expect.objectContaining({
              sessionKey: "agent:researcher:talk",
              runTarget: expect.objectContaining({
                runId: "run-talk",
                signal: expect.any(AbortSignal),
                isCurrent: expect.any(Function),
              }),
              getToolAuthorityOverlay: expect.any(Function),
              text: "latest task",
              mode: "steer",
            }),
          );
          core.resolve();
          await expect(run).resolves.toEqual({ text: "done" });
          expectClaimOnce(lifecycleRunner.claimAppend);
          expect(rpcSourceTesting.has("run-talk")).toBe(false);
          expect(isRunCurrent).toHaveBeenCalledWith("run-talk");
        } finally {
          core.resolve();
          await run.catch(() => undefined);
          clock.mockRestore();
          lifecycleRunner.claimFailureAppend();
        }
      }),
  );

  it("keeps simultaneous same-ID consult completions with their physical stores", async () => {
    rpcSourceTesting.clear();
    const publish = gate();
    const finish = gate();
    const consults = ["a", "b"].map((name) => {
      const runId = `run-talk-${name}`;
      const storePath = `/tmp/talk-store-${name}/sessions.json`;
      const runner = createOwnedRunner({
        sessionTarget: {
          agentId: "researcher",
          sessionKey: "main",
          canonicalKey: "agent:researcher:talk",
          storePath,
          assertCurrent: vi.fn(),
        },
      });
      runner.runPrompt.adoptCompletionClaims();
      return {
        runId,
        storePath,
        runner,
        prepared: gate(),
        registered: gate(),
        instance: { instanceId: `instance:${runId}`, runId },
      };
    });
    mocks.createOperationalRunInstanceRef.mockImplementation(
      (runId: string) => consults.find((consult) => consult.runId === runId)!.instance,
    );
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      const consult = consults.find((candidate) => candidate.storePath === params.storePath)!;
      await params.onRunStarted?.({
        runId: consult.runId,
        sessionId: "session-talk",
        timeoutMs: 60_000,
      });
      consult.prepared.resolve();
      await publish.promise;
      await params.agentRuntime.runEmbeddedAgent({
        ...coreParams,
        runId: consult.runId,
        sessionTarget: { ...coreParams.sessionTarget!, storePath: consult.storePath },
      });
      return { text: consult.runId };
    });
    mocks.runEmbeddedAgentCore.mockImplementation(async (params: typeof coreParams) => {
      const consult = consults.find((candidate) => candidate.runId === params.runId)!;
      const handle = createEmbeddedRunHandle({ runId: consult.runId });
      await withBackendAuthority(
        consult.instance,
        () => consult.runId,
        "attempt",
        () => {},
        async (operation) => {
          const attachment = attachActiveEmbeddedRun(
            "session-talk",
            handle,
            "agent:researcher:talk",
            undefined,
            "researcher",
            operation,
          );
          consult.registered.resolve();
          try {
            await finish.promise;
          } finally {
            detachActiveEmbeddedRun(
              "session-talk",
              handle,
              "agent:researcher:talk",
              undefined,
              "run_completed",
              attachment,
            );
          }
        },
      );
      return { payloads: [] };
    });
    const runs = consults.map(({ runner }) => runner.runPrompt({ prompt: "finish this task" }));
    const completed = Promise.all(runs);
    try {
      await Promise.race([
        Promise.all(consults.map(({ prepared }) => prepared.promise)),
        completed,
      ]);
      publish.resolve();
      await Promise.race([
        Promise.all(consults.map(({ registered }) => registered.promise)),
        completed,
      ]);
      finish.resolve();
      await expect(completed).resolves.toEqual([{ text: "run-talk-a" }, { text: "run-talk-b" }]);
      for (const { runner } of consults) {
        expectClaimOnce(runner.runPrompt.claimAppend);
      }
    } finally {
      publish.resolve();
      finish.resolve();
      await Promise.allSettled(runs);
      for (const { runner } of consults) {
        runner.runPrompt.claimFailureAppend();
      }
    }
  });

  it("waits for backend publication and projects its registered caller authority", async () => {
    const announced = gate();
    const publish = gate();
    rpcSourceTesting.clear();
    const client = sharingPolicyClient({
      deviceId: "caller-device",
      scopes: ["operator.admin"],
    });
    const authority = resolveTalkAgentConsultAuthority(client.connect.scopes, client);
    const handle = createEmbeddedRunHandle({ runId: "run-talk" });
    const projectToolAuthority = vi.fn((_overlay: ReplyToolAuthorityOverlay) => "authority");
    const { finish } = pendingBackend("publication", handle, async (instance) => {
      announced.resolve();
      await publish.promise;
      await publishBackend(handle, instance, projectToolAuthority, "reply");
    });
    const { runner, run } = startOwnedConsult({ authority });
    await announced.promise;
    const steer = runner.runPrompt.steer;
    if (!steer) {
      throw new Error("owned Talk runner did not expose steering");
    }
    const steering = track(steer({ prompt: "latest task" }));

    await Promise.resolve();
    expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
    publish.resolve();
    await steering;

    const controlParams = mocks.controlRealtimeVoiceAgentRun.mock.calls[0]?.[0];
    expect(controlParams).toMatchObject({
      sessionKey: "agent:researcher:talk",
      runTarget: expect.objectContaining({ runId: "run-talk" }),
      getToolAuthorityOverlay: expect.any(Function),
      text: "latest task",
      mode: "steer",
    });
    const expectedOverlay = runner.getToolAuthorityOverlay(authority, "reply");
    const capturedOverlay = controlParams?.getToolAuthorityOverlay?.();
    expect(capturedOverlay).toEqual(expectedOverlay);
    if (capturedOverlay) {
      await controlParams?.prepareToolAuthorityOverlay?.(capturedOverlay);
    }
    expect(projectToolAuthority).toHaveBeenCalledWith(expectedOverlay);
    finish.resolve();
    await run;
    expectClaimOnce(runner.runPrompt.claimAppend);
    expect(rpcSourceTesting.has("run-talk")).toBe(false);
    expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: true }),
    );
    expect(mocks.consultRealtimeVoiceAgent.mock.calls[0]?.[0]?.toolsAllow).toBeUndefined();
  });

  it("refreshes steering authority when the admitted run publishes a new attempt", async () => {
    rpcSourceTesting.clear();
    const firstHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const secondHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    let firstLive = true;
    const firstProject = vi.fn((_overlay: ReplyToolAuthorityOverlay) => {
      if (!firstLive) {
        throw new Error("first attempt expired");
      }
      return "first-authority";
    });
    const secondProject = vi.fn((_overlay: ReplyToolAuthorityOverlay) => "second-authority");
    const { published } = pendingBackend("retry", secondHandle, async (instance) => {
      await publishBackend(firstHandle, instance, firstProject, "attempt", () => {
        if (!firstLive) {
          throw new Error("first attempt expired");
        }
      });
      await Promise.resolve();
      firstLive = false;
      clearActiveEmbeddedRun("session-talk", firstHandle, "agent:researcher:talk");
      await publishBackend(secondHandle, instance, secondProject, "attempt");
    });
    mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(projectSteering);
    const { runner } = startOwnedConsult();
    await published.promise;

    await expect(runner.runPrompt.steer?.({ prompt: "latest task" })).resolves.toEqual({
      text: "",
    });
    expect(firstProject).not.toHaveBeenCalled();
    expect(secondProject).toHaveBeenCalledOnce();
  });

  it("rejects steering when a replacement reuses the run id from another admission", async () => {
    const outbound = vi.fn();
    const replacementRun = { instanceId: "instance:replacement", runId: "run-talk" };
    const firstHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const secondHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const ownerProject = (_overlay: ReplyToolAuthorityOverlay) => "owner-authority";
    const replacementProject = vi.fn(
      (_overlay: ReplyToolAuthorityOverlay) => "replacement-authority",
    );
    const { published } = pendingBackend("owner", secondHandle, async (instance) => {
      await publishBackend(firstHandle, instance, ownerProject, "attempt");
      clearActiveEmbeddedRun("session-talk", firstHandle, "agent:researcher:talk");
      await publishBackend(secondHandle, replacementRun, replacementProject, "attempt");
    });
    mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(async (params) => {
      params.getToolAuthorityOverlay?.();
      outbound();
      throw new Error("unexpected outbound enqueue");
    });
    const { runner } = startOwnedConsult();
    await published.promise;

    await expect(runner.runPrompt.steer?.({ prompt: "latest task" })).rejects.toThrow(
      "backend is no longer current",
    );
    expect(replacementProject).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each(["announcement", "admission"] as const)(
    "rejects a stale owner at %s without changing its replacement",
    async (phase) => {
      const waiting = [gate(), gate()];
      const release = [gate(), gate()];
      const registerRun = vi.fn(async () => ({ release: vi.fn(), isCurrent: () => true }));
      const project = vi.fn((_overlay: ReplyToolAuthorityOverlay) => "current-authority");
      let invocation = 0;
      mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
        const index = invocation++;
        if (phase === "announcement" && index === 0) {
          waiting[0]!.resolve();
          await release[0]!.promise;
        }
        await announce(params, 1);
        if (phase === "admission") {
          waiting[index]!.resolve();
          await release[index]!.promise;
        }
        await params.agentRuntime.runEmbeddedAgent(coreParams);
        return { text: "done" };
      });
      const currentRun = { instanceId: "instance:current", runId: "run-talk" };
      let published: Promise<void> | undefined;
      if (phase === "announcement") {
        rpcSourceTesting.clear();
        const handle = createEmbeddedRunHandle({ runId: "run-talk" });
        published = pendingBackend("current-owner", handle, async (instance) => {
          await publishBackend(handle, instance, project, "attempt");
        }).published.promise;
        mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(projectSteering);
      } else {
        mocks.createOperationalRunInstanceRef.mockReturnValueOnce(currentRun);
      }
      const { runner, run: first } = startOwnedConsult({ registerRun });
      await waiting[0]!.promise;
      expect(runner.runPrompt.claimFailureAppend()).toBe(true);
      const second = track(runner.runPrompt({ prompt: "replacement task" }));
      await (published ?? waiting[1]!.promise);

      release[0]!.resolve();
      await expect(first).rejects.toThrow("admission is no longer current");
      if (phase === "admission") {
        expect(mocks.createOperationalRunInstanceRef).not.toHaveBeenCalled();
        expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
        release[1]!.resolve();
        await expect(second).resolves.toEqual({ text: "done" });
        expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledOnce();
        expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledWith(
          expect.objectContaining({ operationalRunInstance: currentRun }),
        );
        expect(runner.runPrompt.claimFailureAppend()).toBe(true);
      } else {
        await expect(runner.runPrompt.steer?.({ prompt: "latest task" })).resolves.toEqual({
          text: "",
        });
        expect(registerRun).toHaveBeenCalledOnce();
        expect(project).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not let a stale runner revoke a replacement completion claim", async () => {
    const staleWaiting = gate();
    const releaseStale = gate();
    const currentStarted = gate();
    const finishCurrent = gate();
    let invocation = 0;
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      const currentInvocation = (invocation += 1);
      if (currentInvocation === 1) {
        staleWaiting.resolve();
        await releaseStale.promise;
      }
      await announce(params, 1);
      if (currentInvocation === 2) {
        currentStarted.resolve();
        await finishCurrent.promise;
      }
      return { text: "done" };
    });
    const runnerOptions = {
      ownerConnId: "connection-owner",
    };
    const staleRunner = createRunner(undefined, undefined, runnerOptions);
    const currentRunner = createRunner(undefined, undefined, runnerOptions);
    let staleCurrent = true;
    finalizers.push(() => {
      staleRunner.runOwnedArgs.claimFailureAppend();
      currentRunner.runOwnedArgs.claimFailureAppend();
    });
    const staleRun = track(
      staleRunner.runOwnedArgs({ question: "stale task" }, undefined, undefined, () => {
        if (!staleCurrent) {
          throw new Error("Realtime voice session is not active");
        }
      }),
    );
    await staleWaiting.promise;
    staleCurrent = false;
    const currentRun = track(
      currentRunner.runOwnedArgs({ question: "replacement task" }, undefined, undefined, () => {}),
    );
    await currentStarted.promise;

    releaseStale.resolve();
    await expect(staleRun).rejects.toThrow("not active");
    expect(currentRunner.runOwnedArgs.claimFailureAppend()).toBe(true);
    finishCurrent.resolve();
    await expect(currentRun).resolves.toEqual({ text: "done" });
  });

  it("installs steering ownership before readiness and delays backend admission", async () => {
    const ready = gate();
    rpcSourceTesting.clear();
    const handle = createEmbeddedRunHandle({ runId: "run-talk" });
    const { finish } = pendingBackend("readiness", handle, async (instance) => {
      const project = (_overlay: ReplyToolAuthorityOverlay) => "authority";
      await publishBackend(handle, instance, project, "attempt");
    });
    const runner = createOwnedRunner();
    const readiness = vi.fn(() => ready.promise);
    const assertCurrent = vi.fn();
    const run = track(
      runner.runOwnedArgs(
        { question: "first task" },
        new AbortController().signal,
        readiness,
        assertCurrent,
      ),
    );
    const steer = runner.runOwnedArgs.steer;
    if (!steer) {
      throw new Error("owned Talk runner did not expose steering");
    }
    const steering = track(steer({ prompt: "latest task" }));

    expect(readiness).toHaveBeenCalledOnce();
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
    ready.resolve();
    await steering;
    expect(assertCurrent).toHaveBeenCalledBefore(mocks.consultRealtimeVoiceAgent);
    expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledBefore(mocks.runEmbeddedAgentCore);
    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledBefore(mocks.controlRealtimeVoiceAgentRun);
    expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledOnce();
    expect(mocks.controlRealtimeVoiceAgentRun).toHaveBeenCalledOnce();
    finish.resolve();
    await expect(run).resolves.toEqual({ text: "done" });
  });

  it.each(["state-switch", "file-replaced"] as const)(
    "keeps browser consult on its published physical source (%s)",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const target = {
          agentId: "researcher",
          sessionKey: "main",
          voiceSessionId: "voice-session",
          origin: "client" as const,
        };
        const originalEnv = { ...process.env };
        const sourcePath = resolveOpenClawAgentSqlitePath(target);
        const otherState = path.join(path.dirname(sourcePath), "other-state");
        await createOrResumeClientVoiceSession(target);
        const source = captureClientVoiceSessionSource(target.agentId);
        if (change === "state-switch") {
          setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
          await createOrResumeClientVoiceSession(target);
          setTestEnvValue("OPENCLAW_STATE_DIR", state.stateDir);
        }
        const ready = gate();
        let published = false;
        const sourceOwner = {
          getVoiceSessionSource: () => {
            if (!published) {
              throw new Error("Browser source has not been published");
            }
            return source;
          },
        };
        const runner = createConsultRunner({
          registerRun: undefined,
          ...sourceOwner,
        });
        mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
          if (change === "state-switch") {
            setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
          }
          await announce(params, 1);
          await params.agentRuntime.runEmbeddedAgent(coreParams);
          return { text: "done" };
        });
        const running = runner.runOwnedArgs(
          { question: "Use this browser's store" },
          undefined,
          () => ready.promise,
        );
        try {
          expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
          if (change === "file-replaced") {
            await closeOpenClawAgentDatabasesAsync(state.stateDir);
            renameSync(sourcePath, `${sourcePath}.original`);
            copyFileSync(`${sourcePath}.original`, sourcePath);
          }
          published = true;
          ready.resolve();
          if (change === "file-replaced") {
            await expect(running).rejects.toThrow();
            expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
            expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
          } else {
            await expect(running).resolves.toEqual({ text: "done" });
            expect(
              readVoiceSessionRecord(target.agentId, target.voiceSessionId, { env: originalEnv }),
            ).toMatchObject({ consultRunIds: ["run-talk"] });
            expect(readVoiceSessionRecord(target.agentId, target.voiceSessionId)).toMatchObject({
              consultRunIds: [],
            });
          }
        } finally {
          ready.resolve();
          await running.catch(() => undefined);
          setTestEnvValue("OPENCLAW_STATE_DIR", state.stateDir);
          clientVoiceSessionTesting.reset();
          await cleanupSessionStateForTest({ stateDir: otherState });
        }
      });
    },
  );

  it("rechecks reusable browser ownership after yielding before backend admission", async () => {
    let current = true;
    const assertCurrent = vi.fn(() => {
      if (!current) {
        throw new Error("Realtime voice session is not active");
      }
    });
    const runner = createRunner();
    const run = runner.runArgs(
      { question: "first task" },
      new AbortController().signal,
      assertCurrent,
    );
    current = false;

    await expect(run).rejects.toThrow("not active");
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
  });

  it.each(["retained source", "owned run"] as const)(
    "rechecks %s authority at embedded-run admission",
    async (kind) => {
      let current = true;
      const assertSourceCurrent = vi.fn(() => {
        if (!current) {
          throw new Error("Realtime voice session is not active");
        }
      });
      mocks.createOperationalRunInstanceRef.mockImplementationOnce((runId: string) => {
        current = false;
        return { instanceId: `instance:${runId}`, runId };
      });
      const runner =
        kind === "retained source"
          ? createConsultRunner({
              runAuthority: {
                retainRun: async () => ({ assertSourceCurrent, release: vi.fn() }),
              } as never,
            })
          : createRunner(
              vi.fn(async () => ({ release: vi.fn(), isCurrent: () => current })),
              undefined,
              { ownerConnId: "connection-owner" },
            );
      if (kind === "owned run") {
        runner.runPrompt.adoptCompletionClaims();
      }
      const run =
        kind === "retained source"
          ? runner.runArgs({ question: "first task" })
          : runner.runPrompt({ prompt: "first task" });
      await expect(run).rejects.toThrow(
        kind === "retained source" ? "not active" : "admission is no longer current",
      );
      if (kind === "retained source") {
        expect(assertSourceCurrent).toHaveBeenCalledOnce();
      }
      expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    },
  );

  it.each(["already aborted", "listener registration"] as const)(
    "rejects admission with cancellation at %s",
    async (phase) => {
      const controller = new AbortController();
      const message = phase === "already aborted" ? "already cancelled" : "raced cancellation";
      if (phase === "already aborted") {
        controller.abort(new Error(message));
      } else {
        mocks.prepareAgentRunAdmission.mockImplementationOnce(() => {
          controller.abort(new Error(message));
          return {
            operationalRunInstance: { instanceId: "instance:run-talk", runId: "run-talk" },
            admit: vi.fn(),
            close: mocks.close,
          };
        });
      }
      await expect(
        createRunner().runPrompt({ prompt: "check", signal: controller.signal }),
      ).rejects.toThrow(message);
      if (phase === "already aborted") {
        expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
      } else {
        expect(mocks.close).toHaveBeenCalledOnce();
      }
      expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
    },
  );
});
