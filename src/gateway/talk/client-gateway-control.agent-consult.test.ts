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
import { resolveTalkAgentConsultAuthority } from "./client-tool-authority.js";

type ConsultOverrides = Parameters<typeof createConsultRunner>[0];
const agentId = "researcher";
const sessionId = "session-talk";
const sessionKey = "agent:researcher:talk";
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

function expectUnused(...functions: unknown[]) {
  for (const fn of functions) {
    expect(fn).not.toHaveBeenCalled();
  }
}

function steer(entry: Pick<ReturnType<typeof createRunner>["runPrompt"], "steer">) {
  if (!entry.steer) {
    throw new Error("owned Talk runner did not expose steering");
  }
  return track(entry.steer({ prompt: "latest task" }));
}

function mockConsult(run: (params: ConsultParams) => Promise<void>) {
  mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
    await run(params);
    return { text: "done" };
  });
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

function publishBackend(
  handle: ReturnType<typeof createEmbeddedRunHandle>,
  operationalRunInstance: OperationalRunInstanceRef,
  project: (overlay: ReplyToolAuthorityOverlay) => string,
  source: "reply" | "attempt" = "attempt",
  assertActive = () => {},
) {
  return withGatewayToolCallerIdentity(
    {
      agentId,
      sessionKey,
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
      const attachment = attachActiveEmbeddedRun(
        sessionId,
        handle,
        sessionKey,
        undefined,
        agentId,
        operation,
      );
      return () =>
        detachActiveEmbeddedRun(
          sessionId,
          handle,
          sessionKey,
          undefined,
          "run_completed",
          attachment,
        );
    },
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

  it.each(["success", "failure"] as const)(
    "keeps the released provider callback reusable after %s",
    async (outcome) => {
      if (outcome === "failure") {
        mocks.consultRealtimeVoiceAgent.mockRejectedValueOnce(new Error("consult failed"));
      }
      const runner = createRunner();
      expect(runner.runPrompt).not.toHaveProperty("steer");
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

  it("drops the call's quoted history for the resetting and later consults", async () => {
    const history = [{ role: "user" as const, text: "Quoted call history: PELICAN-DAY1" }];
    const transcripts: unknown[] = [];
    mockConsult(
      async (params) => void transcripts.push(params.transcript, params.onSessionReset?.()),
    );
    mockConsult(async (params) => void transcripts.push(params.transcript));
    const runner = createConsultRunner({ initialItems: history });
    for (const prompt of ["first task", "second task"]) {
      await expect(runner.runPrompt({ prompt })).resolves.toEqual({ text: "done" });
    }
    expect(transcripts).toEqual([history, [], []]);
  });

  it.each(["runOwnedArgs", "runPrompt"] as const)(
    "steers and claims the registered owner through %s",
    async (entrypoint) =>
      withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          storePath: state.statePath("sessions.sqlite"),
        };
        const now = Date.now();
        const staleAt = now - 61 * 60_000;
        await replaceSessionEntry(scope, {
          sessionId: "session-talk",
          updatedAt: staleAt,
          lastInteractionAt: staleAt,
        });
        mockConsult(async (params) => {
          await announce(params);
          await params.agentRuntime.runEmbeddedAgent({
            ...coreParams,
            sessionTarget: { ...scope, sessionId: "session-talk" },
          });
        });
        const entered = gate();
        const publish = gate();
        const ready = gate();
        const assertCurrent = vi.fn();
        const project = vi.fn((_overlay: ReplyToolAuthorityOverlay) => "authority");
        const client = sharingPolicyClient({
          deviceId: "caller-device",
          scopes: ["operator.admin"],
        });
        const authority = resolveTalkAgentConsultAuthority(client.connect.scopes, client);
        const handle = createEmbeddedRunHandle({ runId: "run-talk" });
        const { finish } = pendingBackend(entrypoint, handle, async (instance) => {
          entered.resolve();
          await publish.promise;
          await publishBackend(
            handle,
            instance,
            project,
            entrypoint === "runPrompt" ? "reply" : "attempt",
          );
        });
        const runner = createOwnedRunner({
          authority,
          sessionTarget: { ...scope, canonicalKey: scope.sessionKey, assertCurrent: () => {} },
        });
        const lifecycle = runner[entrypoint];
        runner.runPrompt.adoptCompletionClaims();
        const run = track(
          entrypoint === "runOwnedArgs"
            ? runner.runOwnedArgs(
                { question: "first task" },
                new AbortController().signal,
                () => ready.promise,
                assertCurrent,
              )
            : runner.runPrompt({ prompt: "first task" }),
        );
        mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(async (params: ControlParams) => {
          const recorder = params.createUserTurnTranscriptRecorder?.(params.text);
          if (entrypoint === "runPrompt") {
            expect(recorder).toBeDefined();
            await recorder!.persistApproved();
          } else {
            expect(recorder).toBeUndefined();
          }
          return await projectSteering(params);
        });
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        try {
          const steering = steer(lifecycle);
          if (entrypoint === "runOwnedArgs") {
            expectUnused(
              assertCurrent,
              mocks.consultRealtimeVoiceAgent,
              mocks.prepareAgentRunAdmission,
            );
            ready.resolve();
          }
          await awaitGateBeforeSettlement(entered.promise, run, "Talk backend must register");
          await Promise.resolve();
          expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
          publish.resolve();
          await steering;
          if (entrypoint === "runOwnedArgs") {
            expect(assertCurrent).toHaveBeenCalledBefore(mocks.consultRealtimeVoiceAgent);
          }
          expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledBefore(mocks.runEmbeddedAgentCore);
          expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledBefore(
            mocks.controlRealtimeVoiceAgentRun,
          );
          expect(project).toHaveBeenCalledOnce();
          expect(mocks.consultRealtimeVoiceAgent.mock.calls[0]?.[0]).toMatchObject({
            senderIsOwner: true,
            toolsAllow: undefined,
          });
          expect(loadSessionEntry(scope)?.lastInteractionAt).toBe(
            entrypoint === "runPrompt" ? now : staleAt,
          );
          finish.resolve();
          await expect(run).resolves.toEqual({ text: "done" });
          expectClaimOnce(lifecycle.claimAppend);
          expect(rpcSourceTesting.has("run-talk")).toBe(false);
        } finally {
          ready.resolve();
          publish.resolve();
          finish.resolve();
          await run.catch(() => undefined);
          clock.mockRestore();
          lifecycle.claimFailureAppend();
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
      finalizers.push(() => runner.runPrompt.claimFailureAppend());
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
      const detach = await publishBackend(handle, consult.instance, () => consult.runId);
      consult.registered.resolve();
      try {
        await finish.promise;
      } finally {
        detach();
      }
      return { payloads: [] };
    });
    const runs = consults.map(({ runner }) =>
      track(runner.runPrompt({ prompt: "finish this task" })),
    );
    const completed = Promise.all(runs);
    await Promise.race([Promise.all(consults.map(({ prepared }) => prepared.promise)), completed]);
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
  });

  it.each([false, true])(
    "accepts a new attempt only within the same admission (foreign=%s)",
    async (foreign) => {
      const first = createEmbeddedRunHandle({ runId: "run-talk" });
      const next = createEmbeddedRunHandle({ runId: "run-talk" });
      let live = true;
      const assertActive = () => {
        if (!live) {
          throw new Error("first attempt expired");
        }
      };
      const firstProject = vi.fn((_overlay: ReplyToolAuthorityOverlay) => {
        assertActive();
        return "first-authority";
      });
      const nextProject = vi.fn((_overlay: ReplyToolAuthorityOverlay) => "next-authority");
      const outbound = vi.fn();
      const { published } = pendingBackend("owner", next, async (instance) => {
        await publishBackend(first, instance, firstProject, "attempt", assertActive);
        await Promise.resolve();
        live = false;
        clearActiveEmbeddedRun("session-talk", first, "agent:researcher:talk");
        await publishBackend(
          next,
          foreign ? { instanceId: "instance:replacement", runId: "run-talk" } : instance,
          nextProject,
          "attempt",
        );
      });
      mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(async (params) => {
        const result = await projectSteering(params);
        outbound();
        return result;
      });
      const { runner } = startOwnedConsult();
      await published.promise;
      const steering = steer(runner.runPrompt);
      if (foreign) {
        await expect(steering).rejects.toThrow("backend is no longer current");
        expectUnused(nextProject, outbound);
      } else {
        await expect(steering).resolves.toEqual({ text: "" });
        expect(nextProject).toHaveBeenCalledOnce();
        expect(outbound).toHaveBeenCalledOnce();
      }
      expect(firstProject).not.toHaveBeenCalled();
    },
  );

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
      let published: Promise<void> | undefined;
      if (phase === "announcement") {
        rpcSourceTesting.clear();
        const handle = createEmbeddedRunHandle({ runId: "run-talk" });
        published = pendingBackend("current-owner", handle, async (instance) => {
          await publishBackend(handle, instance, project, "attempt");
        }).published.promise;
        mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(projectSteering);
      }
      const { runner, run: first } = startOwnedConsult({ registerRun });
      await waiting[0]!.promise;
      expect(runner.runPrompt.claimFailureAppend()).toBe(true);
      const second = track(runner.runPrompt({ prompt: "replacement task" }));
      await (published ?? waiting[1]!.promise);

      release[0]!.resolve();
      await expect(first).rejects.toThrow("admission is no longer current");
      if (phase === "admission") {
        expectUnused(mocks.createOperationalRunInstanceRef, mocks.prepareAgentRunAdmission);
        release[1]!.resolve();
        await expect(second).resolves.toEqual({ text: "done" });
        expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledOnce();
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
    const runnerOptions = { ownerConnId: "connection-owner" };
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
        const runner = createConsultRunner({
          registerRun: undefined,
          getVoiceSessionSource: () => {
            if (!published) {
              throw new Error("Browser source has not been published");
            }
            return source;
          },
        });
        mockConsult(async (params) => {
          if (change === "state-switch") {
            setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
          }
          await announce(params, 1);
          await params.agentRuntime.runEmbeddedAgent(coreParams);
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
            expectUnused(mocks.consultRealtimeVoiceAgent, mocks.runEmbeddedAgentCore);
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
