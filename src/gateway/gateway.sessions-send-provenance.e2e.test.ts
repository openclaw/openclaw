import { addAbortListener } from "node:events";
import { expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/config.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { verifyLinkedPrincipalDelivery } from "./gateway.sessions-send-provenance.authority.test-support.js";
import { verifyCollaborativeCancellation } from "./gateway.sessions-send-provenance.cancellation.test-support.js";
import {
  createScenario,
  gateway,
  humanReplies,
  observeProofSteeringAdmission,
  outbound,
  patchProofConfig,
  providerErrors,
  registerProofModelScript,
  runHuman,
  runProofIngress,
  updateSenderPolicies,
  waitForProofRun,
  type RunResult,
  type ProofCase,
  type ProofModelRequest,
} from "./gateway.sessions-send-provenance.test-support.js";

const cases: ProofCase[] = [
  { name: "denied self-send", id: "denied", sender: "guest", agent: "main", denied: true },
  { name: "allowed self-send", id: "allowed", sender: "trusted", agent: "main", denied: false },
  {
    name: "authorized more capable delegate",
    id: "delegate",
    sender: "trusted",
    agent: "research",
    denied: false,
  },
  {
    name: "admitted followup retains denial while waiting despite a policy change",
    id: "busy_followup",
    sender: "guest",
    agent: "main",
    denied: true,
    busy: true,
    targetKey: "agent:main:telegram:direct:provenance-busy-receiver",
  },
  {
    name: "later authorized work in the same receiver",
    id: "busy_allowed",
    sender: "trusted",
    agent: "main",
    denied: false,
    targetKey: "agent:main:telegram:direct:provenance-busy-receiver",
  },
  {
    name: "denied explicit steer to busy authorized receiver",
    id: "busy_steer_denied",
    sender: "guest",
    agent: "main",
    denied: true,
    busy: true,
    mode: "steer",
    targetKey: "agent:main:telegram:direct:provenance-steer-denied",
  },
  {
    name: "compatible explicit steer from the original requester",
    id: "busy_steer_compatible",
    sender: "trusted",
    agent: "main",
    denied: false,
    busy: true,
    mode: "steer",
    bootstrap: true,
    targetKey: "agent:main:telegram:direct:provenance-busy-receiver",
  },
];

async function verifyRegisteredRequesterPolicy(signal: AbortSignal) {
  for (const spec of cases) {
    const sourceKey = `agent:${spec.agent}:telegram:direct:provenance-${spec.id === "allowed" ? "denied" : spec.id}`;
    const scenario = createScenario(spec, sourceKey);
    using diagnostic = addAbortListener(signal, () => {
      process.stderr.write(`[provenance proof aborted] requester case=${spec.id}\n`);
    });
    void diagnostic;
    let incumbent: Promise<unknown> | undefined;
    let source: ReturnType<typeof runProofIngress> | undefined;
    let changedQueuedPolicy = false;
    try {
      if (spec.busy) {
        if (spec.bootstrap) {
          const bootstrap = await runProofIngress({
            abortSignal: signal,
            agentId: spec.agent,
            sessionKey: sourceKey,
            message: scenario.bootstrapPrompt,
            senderId: spec.sender,
            to: scenario.sourceRecipient,
          });
          expect(bootstrap).toMatchObject({
            payloads: [expect.objectContaining({ text: `BOOTSTRAP_COMPLETE_${spec.id}` })],
          });
          expect(
            scenario.bootstrapAccepted,
            JSON.stringify(scenario.bootstrapAccepted),
          ).toMatchObject({
            status: "accepted",
            targetDisposition: "queued",
            runId: expect.any(String),
          });
          incumbent = waitForProofRun(scenario.bootstrapAccepted?.runId);
        } else {
          incumbent = runProofIngress({
            abortSignal: signal,
            agentId: "main",
            sessionKey: scenario.targetKey,
            message: scenario.incumbentPrompt,
            senderId: "trusted",
            to: `${scenario.sourceRecipient}-incumbent`,
          });
        }
        incumbent = incumbent.then((result) => {
          scenario.incumbentCompleted = true;
          return result;
        });
        await withinTest(
          awaitGateBeforeSettlement(
            scenario.incumbentStarted.promise,
            incumbent,
            "Authorized receiver settled before its first delivery",
          ),
          signal,
        );
      }
      source = runProofIngress({
        abortSignal: signal,
        agentId: spec.agent,
        sessionKey: sourceKey,
        message: scenario.sourcePrompt,
        senderId: spec.sender,
        to: scenario.sourceRecipient,
      });
      const sourceResult = await source;
      scenario.sourceCompleted = true;
      expect(sourceResult).toMatchObject({
        payloads: [expect.objectContaining({ text: `SOURCE_COMPLETE_${spec.id}` })],
      });
      const rejectedSteering = spec.mode === "steer" && spec.denied;
      expect(
        scenario.accepted,
        JSON.stringify({ accepted: scenario.accepted, providerErrors }),
      ).toMatchObject({
        status: rejectedSteering ? "error" : "accepted",
        runId: expect.any(String),
      });
      if (rejectedSteering) {
        expect(scenario.accepted?.error).toMatch(/different requester.*followup/);
      }
      expect(scenario.sourceRequests[0]?.tools).toContain("sessions_send");
      if (spec.denied || spec.id === "delegate") {
        expect(scenario.sourceRequests[0]?.tools).not.toContain("message");
      } else {
        expect(scenario.sourceRequests[0]?.tools).toContain("message");
      }
      if (spec.busy) {
        if (!rejectedSteering) {
          expect(scenario.accepted).toMatchObject({
            targetDisposition: spec.mode === "steer" ? "steered" : "queued",
          });
        }
        if (!spec.bootstrap) {
          expect(scenario.incumbentCompleted).toBe(false);
          expect(scenario.targetRequests).toEqual([]);
        } else {
          scenario.releaseTarget.resolve();
        }
        if (spec.id === "busy_followup") {
          // Native acceptance already prepared this execution, unlike a human
          // input still waiting for admission in the shared-conversation case.
          await updateSenderPolicies({ "id:guest": { deny: null } });
          changedQueuedPolicy = true;
          expect(getRuntimeConfig().tools?.toolsBySender?.["id:guest"]?.deny).toBeUndefined();
        }
        scenario.releaseIncumbent.resolve();
        expect(await incumbent).toMatchObject(
          spec.bootstrap
            ? { status: "ok" }
            : {
                payloads: [expect.objectContaining({ text: `INCUMBENT_COMPLETE_${spec.id}` })],
              },
        );
        expect(
          scenario.incumbentRequests.every((request) => request.tools.includes("message")),
        ).toBe(true);
        expect(outbound.filter((entry) => entry.to === `${scenario.recipient}-incumbent`)).toEqual(
          [1, 2].map((index) => ({
            to: `${scenario.recipient}-incumbent`,
            text: `${scenario.marker}_INCUMBENT_${index}`,
            accountId: "default",
          })),
        );
      }
      if (rejectedSteering) {
        await waitForGatewayActiveWork(30_000);
        expect(scenario.targetRequests).toEqual([]);
        expect(outbound.filter((entry) => entry.to === scenario.recipient)).toEqual([]);
        expect(providerErrors).toEqual([]);
        continue;
      }
      if (spec.mode !== "steer") {
        expect(outbound.filter((entry) => entry.text === scenario.marker)).toEqual([]);
      }
      await withinTest(scenario.targetStarted.promise, signal);
      scenario.releaseTarget.resolve();
      if (!spec.bootstrap) {
        const terminal = await waitForProofRun(scenario.accepted?.runId);
        expect(terminal, JSON.stringify(terminal)).toMatchObject({ status: "ok" });
      }
      await waitForGatewayActiveWork(30_000);
      expect(providerErrors).toEqual([]);
      const deliveries = outbound.filter((entry) => entry.to === scenario.recipient);
      expect
        .soft(deliveries, spec.name)
        .toEqual(
          spec.denied
            ? []
            : [{ to: scenario.recipient, text: scenario.marker, accountId: "default" }],
        );
      if (spec.mode !== "steer") {
        expect
          .soft(scenario.effectAfterSourceCompletion, spec.name)
          .toEqual(spec.denied ? [] : [true]);
      }
      expect
        .soft(
          scenario.targetRequests.map((request) => request.tools.includes("message")),
          spec.name,
        )
        .toEqual(scenario.targetRequests.map(() => !spec.denied));
      console.log(
        "[busy receiver proof]",
        JSON.stringify({
          case: spec.id,
          accepted: scenario.accepted,
          incumbentTools: scenario.incumbentRequests.map((request) =>
            request.tools.includes("message"),
          ),
          targetTools: scenario.targetRequests.map((request) => request.tools.includes("message")),
          deliveries,
        }),
      );
      if (scenario.targetKey === sourceKey) {
        expect
          .soft(
            outbound.filter((entry) => entry.to === scenario.sourceRecipient),
            spec.name,
          )
          .toEqual([
            {
              to: scenario.sourceRecipient,
              text: `TARGET_COMPLETE_${spec.id}`,
              accountId: "default",
            },
          ]);
      }
    } finally {
      scenario.releaseIncumbent.resolve();
      scenario.releaseTarget.resolve();
      await Promise.allSettled([source, incumbent]);
      await waitForGatewayActiveWork(30_000);
      if (changedQueuedPolicy) {
        await updateSenderPolicies({ "id:guest": { deny: ["message"] } });
      }
    }
  }
}

async function verifyNativeSpawnRequester(signal: AbortSignal, collect: boolean) {
  const marker = `native_spawn_requester_${collect}`;
  const sourcePrompt = `PROVENANCE_SOURCE_${marker}`;
  const childPrompt = `PROVENANCE_TARGET_${marker}`;
  const steerPrompt = `PROVENANCE_TARGET_${marker}_steer`;
  const spawned = createDeferred();
  const childStarted = createDeferred();
  const issueSteer = createDeferred();
  const releaseChild = createDeferred();
  let spawnResult: Record<string, unknown> | undefined;
  let steerResult: Record<string, unknown> | undefined;
  let sourceRequests = 0;
  let sourceCompleted = false;
  const steeringAfterSourceCompletion: boolean[] = [];
  registerProofModelScript(marker, async (request) => {
    if (request.prompt.includes(steerPrompt)) {
      steeringAfterSourceCompletion.push(sourceCompleted);
      return { text: `PROVENANCE_COMPLETE_${marker}` };
    }
    if (request.prompt.includes(childPrompt)) {
      childStarted.resolve();
      await releaseChild.promise;
      return { text: `PROVENANCE_COMPLETE_${marker}` };
    }
    sourceRequests++;
    if (sourceRequests === 1) {
      return {
        tool: {
          name: "sessions_spawn",
          args: {
            task: childPrompt,
            collect,
            cleanup: "keep",
            expectsCompletionMessage: false,
          },
        },
      };
    }
    if (sourceRequests === 2) {
      spawnResult = request.result;
      spawned.resolve();
      await issueSteer.promise;
      return {
        tool: {
          name: "sessions_send",
          args: {
            sessionKey: spawnResult?.childSessionKey,
            mode: "steer",
            message: steerPrompt,
            timeoutSeconds: 0,
          },
        },
      };
    }
    steerResult = request.result;
    return { text: `PROVENANCE_COMPLETE_${marker}` };
  });
  // The operator client manages the fixture only. This run has channel ingress
  // identity and no linked operator profile, with optional audit capture disabled.
  expect(getRuntimeConfig().logging?.audit).toMatchObject({
    enabled: false,
    executionIdentity: false,
  });
  const source = runProofIngress({
    abortSignal: signal,
    agentId: "boundary",
    sessionKey: `agent:boundary:telegram:direct:${marker}`,
    message: sourcePrompt,
    senderId: marker,
    to: `provenance-${marker}`,
  }).then((result) => {
    sourceCompleted = true;
    return result;
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(spawned.promise, source, "Spawn did not return"),
      signal,
    );
    expect(spawnResult).toMatchObject({
      status: "accepted",
      childSessionKey: expect.any(String),
      runId: expect.any(String),
    });
    await withinTest(
      awaitGateBeforeSettlement(childStarted.promise, source, "Child did not start"),
      signal,
    );
    issueSteer.resolve();
    await source;
    expect(steerResult, JSON.stringify(steerResult)).toMatchObject({
      status: "accepted",
      targetDisposition: "steered",
    });
    releaseChild.resolve();
    expect(await waitForProofRun(spawnResult?.runId)).toMatchObject({ status: "ok" });
    await waitForGatewayActiveWork(30_000);
    expect(steeringAfterSourceCompletion).toEqual([true]);
    expect(providerErrors).toEqual([]);
  } finally {
    issueSteer.resolve();
    releaseChild.resolve();
    await Promise.allSettled([source]);
    await waitForGatewayActiveWork(30_000);
  }
}

async function verifyQueuedCollectorAdmission(signal: AbortSignal) {
  const marker = "queued_collector_requester";
  const sourceKey = `agent:boundary:telegram:direct:${marker}`;
  const sourcePrompt = `PROVENANCE_SOURCE_${marker}_spawn`;
  const steerSourcePrompt = `PROVENANCE_SOURCE_${marker}_steer`;
  const blockerPrompt = `PROVENANCE_TARGET_${marker}_blocker`;
  const queuedPrompt = `PROVENANCE_TARGET_${marker}_queued`;
  const steerInput = `PROVENANCE_TARGET_${marker}_steer`;
  const blockerStarted = createDeferred();
  const queuedStarted = createDeferred();
  const releaseBlocker = createDeferred();
  const releaseQueued = createDeferred();
  const blockerRequests: ProofModelRequest[] = [];
  const queuedRequests: ProofModelRequest[] = [];
  const queuedAfterSourceCompletion: boolean[] = [];
  let blockerResult: Record<string, unknown> | undefined;
  let queuedResult: Record<string, unknown> | undefined;
  let steerResult: Record<string, unknown> | undefined;
  let sourceRequests = 0;
  let steeringRequests = 0;
  let sourceCompleted = false;
  registerProofModelScript(marker, async (request) => {
    if (request.prompt.includes(steerInput)) {
      queuedRequests.push(request);
      queuedAfterSourceCompletion.push(sourceCompleted);
      return { text: `PROVENANCE_COMPLETE_${marker}` };
    }
    if (request.prompt.includes(queuedPrompt)) {
      queuedRequests.push(request);
      queuedAfterSourceCompletion.push(sourceCompleted);
      queuedStarted.resolve();
      await releaseQueued.promise;
      return { text: `PROVENANCE_COMPLETE_${marker}` };
    }
    if (request.prompt.includes(blockerPrompt)) {
      blockerRequests.push(request);
      blockerStarted.resolve();
      await releaseBlocker.promise;
      return { text: `PROVENANCE_COMPLETE_${marker}` };
    }
    if (request.prompt.includes(steerSourcePrompt)) {
      steeringRequests++;
      if (steeringRequests === 1) {
        return {
          tool: {
            name: "sessions_send",
            args: {
              sessionKey: queuedResult?.childSessionKey,
              mode: "steer",
              message: steerInput,
              timeoutSeconds: 0,
            },
          },
        };
      }
      steerResult = request.result;
      return { text: `PROVENANCE_COMPLETE_${marker}` };
    }
    sourceRequests++;
    if (sourceRequests === 1) {
      return {
        tool: {
          name: "sessions_spawn",
          args: { task: blockerPrompt, collect: true, groupId: marker, cleanup: "keep" },
        },
      };
    }
    if (sourceRequests === 2) {
      blockerResult = request.result;
      if (blockerResult?.status !== "accepted") {
        return { text: `PROVENANCE_COMPLETE_${marker}` };
      }
      await blockerStarted.promise;
      return {
        tool: {
          name: "sessions_spawn",
          args: { task: queuedPrompt, collect: true, groupId: marker, cleanup: "keep" },
        },
      };
    }
    queuedResult = request.result;
    return { text: `PROVENANCE_COMPLETE_${marker}` };
  });
  const previousSwarm = getRuntimeConfig().tools?.swarm;
  const ingress = {
    abortSignal: signal,
    agentId: "boundary",
    sessionKey: sourceKey,
    senderId: marker,
    to: `provenance-${marker}`,
  };
  let source: ReturnType<typeof runProofIngress> | undefined;
  let queuedCompletion: Promise<RunResult> | undefined;
  let changedConfig = false;
  try {
    await patchProofConfig({ tools: { swarm: { enabled: true, maxConcurrent: 1 } } });
    changedConfig = true;
    source = runProofIngress({ ...ingress, message: sourcePrompt }).then((result) => {
      sourceCompleted = true;
      return result;
    });
    await withinTest(
      awaitGateBeforeSettlement(blockerStarted.promise, source, "Collector did not start"),
      signal,
    );
    await source;
    for (const accepted of [blockerResult, queuedResult]) {
      expect(accepted).toMatchObject({
        status: "accepted",
        childSessionKey: expect.any(String),
        runId: expect.any(String),
      });
    }
    expect(blockerRequests.length).toBeGreaterThan(0);
    expect(blockerRequests.every((request) => request.tools.includes("exec"))).toBe(true);
    expect(queuedRequests).toEqual([]);
    await updateSenderPolicies({ [`id:${marker}`]: { deny: ["exec"] } });
    queuedCompletion = waitForProofRun(queuedResult?.runId);
    releaseBlocker.resolve();
    await withinTest(
      awaitGateBeforeSettlement(
        queuedStarted.promise,
        queuedCompletion,
        "Queued child did not start",
      ),
      signal,
    );
    expect(queuedRequests.every((request) => !request.tools.includes("exec"))).toBe(true);
    await runProofIngress({ ...ingress, message: steerSourcePrompt });
    expect(steerResult, JSON.stringify(steerResult)).toMatchObject({
      status: "accepted",
      targetDisposition: "steered",
    });
    releaseQueued.resolve();
    expect(await queuedCompletion).toMatchObject({ status: "ok" });
    expect(await waitForProofRun(blockerResult?.runId)).toMatchObject({ status: "ok" });
    await waitForGatewayActiveWork(30_000);
    expect(queuedRequests.some((request) => request.prompt.includes(steerInput))).toBe(true);
    expect(queuedRequests.every((request) => !request.tools.includes("exec"))).toBe(true);
    expect(queuedAfterSourceCompletion).toEqual(queuedRequests.map(() => true));
    expect(providerErrors).toEqual([]);
  } finally {
    blockerStarted.resolve();
    releaseBlocker.resolve();
    releaseQueued.resolve();
    await Promise.allSettled([source, queuedCompletion]);
    await waitForGatewayActiveWork(30_000);
    if (changedConfig) {
      await patchProofConfig(
        {
          tools: {
            swarm: previousSwarm ?? null,
            toolsBySender: { [`id:${marker}`]: { deny: null } },
          },
        },
        ["tools.swarm", `tools.toolsBySender.id:${marker}.deny`],
      );
    }
  }
}

async function verifyCompletedChildFollowup(signal: AbortSignal) {
  const marker = "completed_child_policy";
  const sourceKey = `agent:boundary:telegram:direct:${marker}`;
  const spawnPrompt = `PROVENANCE_SOURCE_${marker}_spawn`;
  const sourceFollowupPrompt = `PROVENANCE_SOURCE_${marker}_followup`;
  const childPrompt = `PROVENANCE_TARGET_${marker}_initial`;
  const childFollowupPrompt = `PROVENANCE_TARGET_${marker}_followup`;
  let spawnResult: Record<string, unknown> | undefined;
  let followupResult: Record<string, unknown> | undefined;
  const initialRequests: ProofModelRequest[] = [];
  const followupRequests: ProofModelRequest[] = [];
  let spawnRequests = 0;
  let sourceFollowupRequests = 0;
  registerProofModelScript(marker, (request) => {
    if (request.prompt.includes(childFollowupPrompt)) {
      followupRequests.push(request);
      return { text: `PROVENANCE_COMPLETE_${marker}` };
    }
    if (request.prompt.includes(childPrompt)) {
      initialRequests.push(request);
      return { text: `PROVENANCE_COMPLETE_${marker}` };
    }
    if (request.prompt.includes(sourceFollowupPrompt)) {
      sourceFollowupRequests++;
      if (sourceFollowupRequests === 1) {
        return {
          tool: {
            name: "sessions_send",
            args: {
              sessionKey: spawnResult?.childSessionKey,
              mode: "followup",
              message: childFollowupPrompt,
              timeoutSeconds: 0,
            },
          },
        };
      }
      followupResult = request.result;
      return { text: `PROVENANCE_COMPLETE_${marker}` };
    }
    spawnRequests++;
    if (spawnRequests === 1) {
      return {
        tool: {
          name: "sessions_spawn",
          args: { task: childPrompt, cleanup: "keep", expectsCompletionMessage: false },
        },
      };
    }
    spawnResult = request.result;
    return { text: `PROVENANCE_COMPLETE_${marker}` };
  });
  const ingress = {
    abortSignal: signal,
    agentId: "boundary",
    sessionKey: sourceKey,
    senderId: marker,
    to: `provenance-${marker}`,
  };
  let changedPolicy = false;
  try {
    await runProofIngress({ ...ingress, message: spawnPrompt });
    expect(spawnResult).toMatchObject({
      status: "accepted",
      childSessionKey: expect.any(String),
      runId: expect.any(String),
    });
    const initialCompletion = await waitForProofRun(spawnResult?.runId);
    expect(
      initialCompletion,
      JSON.stringify({ initialCompletion, spawnResult, providerErrors }),
    ).toMatchObject({ status: "ok" });
    await waitForGatewayActiveWork(30_000);
    expect(initialRequests.length).toBeGreaterThan(0);
    expect(initialRequests.every((request) => request.tools.includes("exec"))).toBe(true);
    await updateSenderPolicies({ [`id:${marker}`]: { deny: ["exec"] } });
    changedPolicy = true;
    await runProofIngress({ ...ingress, message: sourceFollowupPrompt });
    expect(
      followupResult,
      JSON.stringify({
        sourceFollowupRequests,
        initialRequests: initialRequests.length,
        followupRequests: followupRequests.length,
      }),
    ).toMatchObject({ status: "accepted", targetDisposition: "queued" });
    expect(await waitForProofRun(followupResult?.runId)).toMatchObject({ status: "ok" });
    await waitForGatewayActiveWork(30_000);
    expect(followupRequests.length).toBeGreaterThan(0);
    expect(followupRequests.map((request) => request.tools.includes("exec"))).toEqual(
      followupRequests.map(() => false),
    );
    expect(providerErrors).toEqual([]);
  } finally {
    await waitForGatewayActiveWork(30_000);
    if (changedPolicy) {
      await updateSenderPolicies({ [`id:${marker}`]: { deny: null } });
    }
  }
}

async function verifySteeringPolicyCompatibility(
  signal: AbortSignal,
  publishDenyAfterAdmission: boolean,
) {
  const marker = `conversation_policy_steer_${publishDenyAfterAdmission}`;
  const groupId = publishDenyAfterAdmission
    ? "provenance-restricted-late"
    : "provenance-restricted";
  let changedGroupPolicy = false;
  const targetKey = `agent:boundary:telegram:direct:${marker}`;
  const incumbentPrompt = `PROVENANCE_INCUMBENT_${marker}`;
  const restrictedPrompt = `PROVENANCE_SOURCE_${marker}_restricted`;
  const compatiblePrompt = `PROVENANCE_SOURCE_${marker}_compatible`;
  const restrictedInput = `PROVENANCE_TARGET_${marker}_restricted`;
  const compatibleInput = `PROVENANCE_TARGET_${marker}_compatible`;
  const started = createDeferred();
  const release = createDeferred();
  const requests: ProofModelRequest[] = [];
  const results = new Map<string, Record<string, unknown> | undefined>();
  const sourceCalls = new Map<string, number>();
  registerProofModelScript(marker, async (request) => {
    requests.push(request);
    if (request.prompt.includes(incumbentPrompt)) {
      started.resolve();
      await release.promise;
      return { text: `PROVENANCE_COMPLETE_${marker}` };
    }
    const source = request.prompt.includes(restrictedPrompt)
      ? restrictedPrompt
      : request.prompt.includes(compatiblePrompt)
        ? compatiblePrompt
        : undefined;
    if (!source) {
      return { text: `PROVENANCE_COMPLETE_${marker}` };
    }
    const count = (sourceCalls.get(source) ?? 0) + 1;
    sourceCalls.set(source, count);
    if (count === 1) {
      return {
        tool: {
          name: "sessions_send",
          args: {
            sessionKey: targetKey,
            mode: "steer",
            message: source === restrictedPrompt ? restrictedInput : compatibleInput,
            timeoutSeconds: 0,
          },
        },
      };
    }
    results.set(source, request.result);
    return { text: `PROVENANCE_COMPLETE_${marker}` };
  });
  const ingress = { abortSignal: signal, agentId: "boundary", senderId: marker };
  const incumbent = runProofIngress({
    ...ingress,
    sessionKey: targetKey,
    message: incumbentPrompt,
    to: `provenance-${marker}`,
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(started.promise, incumbent, "DM did not start"),
      signal,
    );
    expect(requests[0]?.tools).toContain("exec");
    if (publishDenyAfterAdmission) {
      await patchProofConfig({
        channels: { telegram: { groups: { [groupId]: { tools: { deny: ["exec"] } } } } },
      });
      changedGroupPolicy = true;
    }
    expect(getRuntimeConfig()?.channels?.telegram?.groups?.[groupId]?.tools).toEqual({
      deny: ["exec"],
    });
    await runProofIngress({
      ...ingress,
      sessionKey: `agent:boundary:telegram:group:${groupId}`,
      groupId,
      message: restrictedPrompt,
      to: groupId,
    });
    expect(
      requests.find((request) => request.prompt.includes(restrictedPrompt))?.tools,
      JSON.stringify({ groupId, result: results.get(restrictedPrompt) }),
    ).not.toContain("exec");
    expect.soft(results.get(restrictedPrompt)).toMatchObject({ status: "error" });
    expect.soft(results.get(restrictedPrompt)?.error).toMatch(/followup/);
    await runProofIngress({
      ...ingress,
      sessionKey: `agent:boundary:telegram:direct:${marker}-compatible`,
      message: compatiblePrompt,
      to: `provenance-${marker}-compatible`,
    });
    expect(results.get(compatiblePrompt)).toMatchObject({
      status: "accepted",
      targetDisposition: "steered",
    });
    release.resolve();
    await incumbent;
    await waitForGatewayActiveWork(30_000);
    expect(requests.some((request) => request.prompt.includes(restrictedInput))).toBe(false);
    expect(requests.some((request) => request.prompt.includes(compatibleInput))).toBe(true);
    expect(providerErrors).toEqual([]);
  } finally {
    release.resolve();
    await Promise.allSettled([incumbent]);
    await waitForGatewayActiveWork(30_000);
    if (changedGroupPolicy) {
      await patchProofConfig({ channels: { telegram: { groups: { [groupId]: null } } } }, [
        `channels.telegram.groups.${groupId}.tools.deny`,
      ]);
    }
  }
}

// Holding Alice's outbound I/O separates admission from execution and policy publication.
async function verifyCrossHumanAdmission(
  signal: AbortSignal,
  allowCollaborativeSteering: boolean | undefined,
  conversation: "same" | "different" = "same",
) {
  const collaborative = allowCollaborativeSteering === true && conversation === "same";
  const id = `mixed_human_${conversation === "same" ? (allowCollaborativeSteering ?? "default") : "foreign"}`;
  const scenario = createScenario(
    {
      name: `cross-human ${collaborative ? "steer" : "explicit followup"}`,
      id,
      sender: "bob",
      agent: "main",
      denied: !collaborative,
      ...(collaborative ? { targetKey: `agent:deployment:telegram:direct:provenance-${id}` } : {}),
    },
    `agent:main:telegram:group:provenance-${id}`,
  );
  scenario.releaseTarget.resolve();
  const previousSetting = getRuntimeConfig().messages?.queue?.allowCollaborativeSteering;
  const firstReply = humanReplies.length;
  let alice: ReturnType<typeof runHuman> | undefined;
  let bob: ReturnType<typeof runHuman> | undefined;
  let stage = "queue-setting application";
  using diagnostic = addAbortListener(signal, () => {
    process.stderr.write(
      `[provenance proof aborted] ${JSON.stringify({
        case: id,
        stage,
        incumbentCompleted: scenario.incumbentCompleted,
        incumbentRequests: scenario.incumbentRequests.length,
        sourceRequests: scenario.sourceRequests.length,
        targetRequests: scenario.targetRequests.length,
        humanReplies: humanReplies.length - firstReply,
        providerErrors: providerErrors.length,
      })}\n`,
    );
  });
  void diagnostic;
  using steering = await observeProofSteeringAdmission(scenario.sourcePrompt);
  // Disposal retains a body failure when restoring config also fails.
  await using _ = {
    async [Symbol.asyncDispose]() {
      let cleanupStage = "active-work settlement";
      try {
        scenario.releaseIncumbent.resolve();
        scenario.releaseTarget.resolve();
        await Promise.allSettled([alice, bob]);
        await waitForGatewayActiveWork(30_000);
        cleanupStage = "config restoration";
        await patchProofConfig(
          {
            messages: { queue: { allowCollaborativeSteering: previousSetting ?? null } },
            tools: { toolsBySender: { "id:alice": { deny: null }, "id:bob": { deny: null } } },
          },
          [
            "messages.queue.allowCollaborativeSteering",
            "tools.toolsBySender.id:alice.deny",
            "tools.toolsBySender.id:bob.deny",
          ],
        );
      } catch (cause) {
        throw new Error(`${id}: cleanup ${cleanupStage} after ${stage} failed`, { cause });
      }
    },
  };
  try {
    if (collaborative) {
      await gateway.client.request("sessions.create", {
        key: scenario.targetKey,
        agentId: "deployment",
      });
    }
    await patchProofConfig(
      { messages: { queue: { allowCollaborativeSteering: allowCollaborativeSteering ?? null } } },
      ["messages.queue.allowCollaborativeSteering"],
    );
    expect(getRuntimeConfig().messages?.queue?.allowCollaborativeSteering).toBe(
      allowCollaborativeSteering,
    );
    stage = "sender-policy preparation";
    await updateSenderPolicies({
      "id:alice": { deny: null },
      "id:bob": { deny: allowCollaborativeSteering === true ? ["message"] : null },
    });
    stage = "Alice admission";
    alice = runHuman(scenario, "alice", scenario.incumbentPrompt, "steer", signal).then(
      (result) => {
        scenario.incumbentCompleted = true;
        return result;
      },
    );
    await withinTest(
      awaitGateBeforeSettlement(
        scenario.incumbentStarted.promise,
        alice,
        "Alice settled before her first delivery",
      ),
      signal,
    );
    stage = "Bob steering admission";
    bob = runHuman(
      conversation === "same"
        ? scenario
        : { ...scenario, sourceRecipient: `${scenario.sourceRecipient}-other` },
      "bob",
      scenario.sourcePrompt,
      "steer",
      signal,
    );
    if (collaborative) {
      // The receipt waits for transcript commitment, which needs Alice's held
      // tool to finish. Observe real admission before releasing that tool.
      await withinTest(
        awaitGateBeforeSettlement(steering.admitted, bob, "Bob settled before steering admission"),
        signal,
      );
    } else if (allowCollaborativeSteering !== true) {
      expect(await bob).toMatchObject({ collaborativeSteeringRefused: true });
      expect(scenario.sourceRequests).toEqual([]);
      expect(scenario.incumbentCompleted).toBe(false);
      stage = "Bob explicit followup admission";
      bob = runHuman(scenario, "bob", `/followup ${scenario.sourcePrompt}`, "steer", signal);
      expect((await bob).deferredToActiveRun).toBe("followup");
    } else {
      expect((await bob).deferredToActiveRun).toBe("followup");
    }
    expect(humanReplies.slice(firstReply).filter((reply) => reply.sender === "bob")).toEqual(
      collaborative
        ? []
        : [
            ...(allowCollaborativeSteering !== true
              ? [
                  {
                    sender: "bob",
                    text: "Someone else’s turn is still running, and collaborative steering is disabled. Your message wasn’t queued. Resend it as /followup <message> to run it afterward.\n\nAdmins can enable collaborative steering with messages.queue.allowCollaborativeSteering: true.",
                  },
                ]
              : []),
            {
              sender: "bob",
              text: "Your message is queued for a new turn after the current turn finishes. It hasn’t changed the work already in progress.",
            },
          ],
    );
    expect(scenario.incumbentCompleted).toBe(false);
    expect(scenario.sourceRequests).toEqual([]);
    stage = "current-policy update";
    if (collaborative) {
      // Alice keeps her prepared tools. A later delegation reads her updated
      // requester policy and the destination's own configured restriction.
      await patchProofConfig({
        tools: { toolsBySender: { "id:alice": { deny: ["sessions_list"] } } },
      });
    } else {
      await updateSenderPolicies({
        "id:alice": { deny: ["message"] },
        "id:bob": { deny: ["message"] },
      });
    }
    expect(getRuntimeConfig().tools?.toolsBySender?.["id:bob"]).toEqual({ deny: ["message"] });
    stage = "Alice and delegate completion";
    scenario.releaseIncumbent.resolve();
    expect((await bob).deferredToActiveRun).toBe(collaborative ? "steer" : "followup");
    await alice;
    await waitForGatewayActiveWork(30_000);
    stage = "result assertions";
    expect(providerErrors).toEqual([]);
    expect(scenario.accepted, JSON.stringify(scenario.accepted)).toMatchObject({
      status: "accepted",
    });
    expect(scenario.incumbentRequests.every((request) => request.tools.includes("message"))).toBe(
      true,
    );
    expect(scenario.targetRequests.length).toBeGreaterThan(0);
    expect(scenario.sourceRequests.map((request) => request.tools.includes("message"))).toEqual(
      scenario.sourceRequests.map(() => collaborative),
    );
    expect(scenario.targetRequests.map((request) => request.tools.includes("message"))).toEqual(
      scenario.targetRequests.map(() => collaborative),
    );
    if (collaborative) {
      expect(scenario.sourceRequests.length).toBeGreaterThanOrEqual(2);
      for (const request of scenario.sourceRequests.slice(0, 2)) {
        expect(request.tools).toContain("sessions_list");
        expect(request.tools).toContain("sessions_history");
      }
      for (const request of scenario.targetRequests) {
        expect(request.tools).not.toContain("sessions_list");
        expect(request.tools).not.toContain("sessions_history");
      }
    }
    expect(outbound.filter((item) => item.to === scenario.recipient)).toEqual(
      collaborative
        ? [{ to: scenario.recipient, text: scenario.marker, accountId: "default" }]
        : [],
    );
    expect(
      outbound
        .filter((item) => item.to === `${scenario.recipient}-incumbent`)
        .map((item) => item.text),
    ).toEqual(
      (collaborative ? [1] : [1, 2]).map((index) => `${scenario.marker}_INCUMBENT_${index}`),
    );
  } catch (cause) {
    throw new Error(`${id}: ${stage} failed`, { cause });
  }
}

// Global runtime cleanup retires the Gateway's plugin owner after each test.
// Keep this shared Gateway and all registered boundary scenarios in one lifetime.
it(
  "preserves requester provenance across delegation, steering, and queued human input",
  { timeout: 90_000 },
  async ({ signal }) => {
    let phase = "registered requester policy";
    // Native timeout can win over wrapped errors from an awaited scenario.
    using diagnostic = addAbortListener(signal, () => {
      process.stderr.write(`[provenance proof aborted] phase=${phase}\n`);
    });
    void diagnostic;
    await verifyRegisteredRequesterPolicy(signal);
    phase = "native spawn";
    await verifyNativeSpawnRequester(signal, false);
    phase = "native collector spawn";
    await verifyNativeSpawnRequester(signal, true);
    phase = "queued collector admission";
    await verifyQueuedCollectorAdmission(signal);
    phase = "completed child followup";
    await verifyCompletedChildFollowup(signal);
    phase = "steering policy compatibility";
    await verifySteeringPolicyCompatibility(signal, false);
    phase = "steering policy change";
    await verifySteeringPolicyCompatibility(signal, true);
    phase = "cross-human false";
    await verifyCrossHumanAdmission(signal, false);
    phase = "cross-human default";
    await verifyCrossHumanAdmission(signal, undefined);
    phase = "cross-human true";
    await verifyCrossHumanAdmission(signal, true);
    phase = "different-conversation input";
    await verifyCrossHumanAdmission(signal, true, "different");
    phase = "collaborative cancellation";
    await verifyCollaborativeCancellation(signal);
    phase = "linked principal final delivery";
    await verifyLinkedPrincipalDelivery(signal);
  },
);
