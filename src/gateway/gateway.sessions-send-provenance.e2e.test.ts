import { addAbortListener } from "node:events";
import { expect, it } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/config.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { verifyLinkedPrincipalDelivery } from "./gateway.sessions-send-provenance.authority.test-support.js";
import { verifyCollaborativeCancellation } from "./gateway.sessions-send-provenance.cancellation.test-support.js";
import {
  createScenario,
  expectProofIdle,
  gateway,
  humanReplies,
  observeProofSteeringAdmission,
  outbound,
  patchProofConfig,
  registerProofModelScript,
  runHuman,
  runProofIngress,
  updateSenderPolicies,
  waitForProofRun,
  waitForProofGate,
  proofDeliveries,
  proofSend,
  proofSpawn,
  configureProofCollaboration,
  settleProofScenario,
  requesterCase,
  FOLLOWUP_REPLY,
  STEERING_REFUSED_REPLY,
  type RunResult,
  type ProofModelRequest,
  type ProofModelReply,
} from "./gateway.sessions-send-provenance.test-support.js";

const busyReceiver = "agent:main:telegram:direct:provenance-busy-receiver";
const cases = [
  requesterCase("denied", "denied self-send", { sender: "guest", denied: true }),
  requesterCase("allowed", "allowed self-send"),
  requesterCase("delegate", "authorized more capable delegate", { agent: "research" }),
  requesterCase("busy_followup", "admitted followup retains denial despite a policy change", {
    sender: "guest",
    denied: true,
    busy: true,
    targetKey: busyReceiver,
  }),
  requesterCase("busy_allowed", "later authorized work in the same receiver", {
    targetKey: busyReceiver,
  }),
  requesterCase("busy_steer_denied", "denied explicit steer to busy authorized receiver", {
    sender: "guest",
    denied: true,
    busy: true,
    mode: "steer",
    targetKey: "agent:main:telegram:direct:provenance-steer-denied",
  }),
  requesterCase("busy_steer_compatible", "compatible explicit steer from the original requester", {
    busy: true,
    mode: "steer",
    bootstrap: true,
    targetKey: busyReceiver,
  }),
];
const acceptedSpawn = {
  status: "accepted",
  childSessionKey: expect.any(String),
  runId: expect.any(String),
};
const acceptedSteer = { status: "accepted", targetDisposition: "steered" };
const sentMessage = (to: string, text: string) => [{ to, text, accountId: "default" }];

function expectToolAvailability(
  requests: readonly { tools: string[] }[],
  tool: string,
  available: boolean,
  name?: string,
) {
  const actual = requests.map((request) => request.tools.includes(tool));
  const assertion = name === undefined ? expect(actual) : expect.soft(actual, name);
  assertion.toEqual(requests.map(() => available));
}

function createProofIngress(signal: AbortSignal, marker: string) {
  return (
    message: string,
    route: Partial<
      Pick<Parameters<typeof runProofIngress>[0], "sessionKey" | "to" | "groupId">
    > = {},
  ) =>
    runProofIngress({
      abortSignal: signal,
      agentId: "boundary",
      senderId: marker,
      sessionKey: `agent:boundary:telegram:direct:${marker}`,
      to: `provenance-${marker}`,
      message,
      ...route,
    });
}

type ScriptStep = (
  request: ProofModelRequest,
) => ProofModelReply | void | Promise<ProofModelReply | void>;

function createProofScript(marker: string) {
  const requests: ProofModelRequest[] = [];
  const routes: Array<{
    prompt: string;
    steps: ScriptStep[];
    repeat: boolean;
    state: { requests: ProofModelRequest[]; result?: Record<string, unknown> };
  }> = [];
  registerProofModelScript(marker, async (request) => {
    requests.push(request);
    const route = routes.find(({ prompt }) => request.prompt.includes(prompt));
    if (!route) {
      throw new Error(`No scripted route for ${marker}`);
    }
    route.state.requests.push(request);
    route.state.result = request.result;
    return (
      (await route.steps[route.repeat ? 0 : route.state.requests.length - 1]?.(request)) ?? {
        text: `PROVENANCE_COMPLETE_${marker}`,
      }
    );
  });
  const add = (prompt: string, steps: ScriptStep[], repeat = false) => {
    const state: { requests: ProofModelRequest[]; result?: Record<string, unknown> } = {
      requests: [],
    };
    routes.push({ prompt, steps, state, repeat });
    return state;
  };
  return {
    requests,
    on: (prompt: string, ...steps: ScriptStep[]) => add(prompt, steps),
    every: (prompt: string, step: ScriptStep) => add(prompt, [step], true),
  };
}

async function verifyRegisteredRequesterPolicy(signal: AbortSignal) {
  for (const spec of cases) {
    const sourceKey = `agent:${spec.agent}:telegram:direct:provenance-${spec.id === "allowed" ? "denied" : spec.id}`;
    const scenario = createScenario(spec, sourceKey);
    const ingress = {
      abortSignal: signal,
      agentId: spec.agent,
      sessionKey: sourceKey,
      senderId: spec.sender,
      to: scenario.sourceRecipient,
    };
    using steering =
      spec.mode === "steer" && !spec.denied
        ? await observeProofSteeringAdmission(scenario.targetPrompt)
        : undefined;
    let incumbent: Promise<unknown> | undefined;
    let source: ReturnType<typeof runProofIngress> | undefined;
    let changedQueuedPolicy = false;
    try {
      if (spec.busy) {
        if (spec.bootstrap) {
          const bootstrap = await runProofIngress({
            ...ingress,
            message: scenario.bootstrapPrompt,
          });
          expect(bootstrap).toMatchObject({
            payloads: [expect.objectContaining({ text: `BOOTSTRAP_COMPLETE_${spec.id}` })],
          });
          expect(scenario.bootstrapAccepted).toMatchObject({
            status: "accepted",
            targetDisposition: "queued",
            runId: expect.any(String),
          });
          incumbent = waitForProofRun(scenario.bootstrapAccepted?.runId);
        } else {
          incumbent = runProofIngress({
            ...ingress,
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
        await waitForProofGate(
          scenario.incumbentStarted.promise,
          incumbent,
          signal,
          "Authorized receiver settled before its first delivery",
        );
      }
      source = runProofIngress({ ...ingress, message: scenario.sourcePrompt });
      if (steering) {
        await steering.waitForAdmission(source, signal);
        scenario.releaseIncumbent.resolve();
        scenario.releaseTarget.resolve();
      }
      const sourceResult = await source;
      scenario.sourceCompleted = true;
      expect(sourceResult).toMatchObject({
        payloads: [expect.objectContaining({ text: `SOURCE_COMPLETE_${spec.id}` })],
      });
      const rejectedSteering = spec.mode === "steer" && spec.denied;
      expect(scenario.accepted).toMatchObject({
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
        expectToolAvailability(scenario.incumbentRequests, "message", true);
        expect(proofDeliveries(`${scenario.recipient}-incumbent`)).toEqual(
          [1, 2].flatMap((index) =>
            sentMessage(`${scenario.recipient}-incumbent`, `${scenario.marker}_INCUMBENT_${index}`),
          ),
        );
      }
      if (rejectedSteering) {
        await expectProofIdle();
        expect(scenario.targetRequests).toEqual([]);
        expect(proofDeliveries(scenario.recipient)).toEqual([]);
        continue;
      }
      if (spec.mode !== "steer") {
        expect(outbound.filter((entry) => entry.text === scenario.marker)).toEqual([]);
      }
      await withinTest(scenario.targetStarted.promise, signal);
      scenario.releaseTarget.resolve();
      if (!spec.bootstrap) {
        const terminal = await waitForProofRun(scenario.accepted?.runId);
        expect(terminal).toMatchObject({ status: "ok" });
      }
      await expectProofIdle();
      const deliveries = proofDeliveries(scenario.recipient);
      expect
        .soft(deliveries, spec.name)
        .toEqual(spec.denied ? [] : sentMessage(scenario.recipient, scenario.marker));
      if (spec.mode !== "steer") {
        expect
          .soft(scenario.effectAfterSourceCompletion, spec.name)
          .toEqual(spec.denied ? [] : [true]);
      }
      if (spec.denied) {
        expect
          .soft(scenario.targetRequests[1]?.output, spec.name)
          .toMatch(/^(Tool message not found|message is not available in this turn\.)/);
      } else {
        expectToolAvailability(scenario.targetRequests, "message", true, spec.name);
      }
      if (scenario.targetKey === sourceKey) {
        expect
          .soft(proofDeliveries(scenario.sourceRecipient), spec.name)
          .toEqual(sentMessage(scenario.sourceRecipient, `TARGET_COMPLETE_${spec.id}`));
      }
    } finally {
      await settleProofScenario(scenario, [source, incumbent]);
      if (changedQueuedPolicy) {
        await updateSenderPolicies({ "id:guest": { deny: ["message"] } });
      }
    }
  }
}

async function verifyNativeSpawnRequester(signal: AbortSignal, collect: boolean) {
  const marker = `native_spawn_requester_${collect}`;
  const run = createProofIngress(signal, marker);
  const sourcePrompt = `PROVENANCE_SOURCE_${marker}`;
  const childPrompt = `PROVENANCE_TARGET_${marker}`;
  const steerPrompt = `PROVENANCE_TARGET_${marker}_steer`;
  using steering = await observeProofSteeringAdmission(steerPrompt);
  const spawned = createDeferred();
  const childStarted = createDeferred();
  const issueSteer = createDeferred();
  const releaseChild = createDeferred();
  let sourceCompleted = false;
  const steeringAfterSourceCompletion: boolean[] = [];
  const script = createProofScript(marker);
  script.every(steerPrompt, async () => {
    // Hold continuation past parent completion, after steering is committed.
    await withinTest(source, signal);
    steeringAfterSourceCompletion.push(sourceCompleted);
  });
  script.every(childPrompt, async () => {
    childStarted.resolve();
    await releaseChild.promise;
  });
  const parent = script.on(
    "",
    () => proofSpawn(childPrompt, { collect, expectsCompletionMessage: false }),
    async () => {
      spawned.resolve();
      await issueSteer.promise;
      return proofSend(parent.result?.childSessionKey, steerPrompt, "steer");
    },
  );
  // The operator client manages the fixture only. This run has channel ingress
  // identity and no linked operator profile, with optional audit capture disabled.
  expect(getRuntimeConfig().logging?.audit).toMatchObject({
    enabled: false,
    executionIdentity: false,
  });
  const source = run(sourcePrompt).then((result) => {
    sourceCompleted = true;
    return result;
  });
  try {
    await waitForProofGate(spawned.promise, source, signal, "Spawn did not return");
    const spawnResult = parent.requests[1]?.result;
    expect(spawnResult).toMatchObject(acceptedSpawn);
    await waitForProofGate(childStarted.promise, source, signal, "Child did not start");
    issueSteer.resolve();
    await steering.waitForAdmission(source, signal);
    releaseChild.resolve();
    await source;
    expect(parent.result).toMatchObject(acceptedSteer);
    expect(await waitForProofRun(spawnResult?.runId)).toMatchObject({ status: "ok" });
    await expectProofIdle();
    expect(steeringAfterSourceCompletion).toEqual([true]);
  } finally {
    issueSteer.resolve();
    releaseChild.resolve();
    await Promise.allSettled([source]);
    await waitForGatewayActiveWork(30_000);
  }
}

async function verifyQueuedCollectorAdmission(signal: AbortSignal) {
  const marker = "queued_collector_requester";
  const run = createProofIngress(signal, marker);
  const sourcePrompt = `PROVENANCE_SOURCE_${marker}_spawn`;
  const steerSourcePrompt = `PROVENANCE_SOURCE_${marker}_steer`;
  const blockerPrompt = `PROVENANCE_TARGET_${marker}_blocker`;
  const queuedPrompt = `PROVENANCE_TARGET_${marker}_queued`;
  const steerInput = `PROVENANCE_TARGET_${marker}_steer`;
  using steering = await observeProofSteeringAdmission(steerInput);
  const blockerStarted = createDeferred();
  const queuedStarted = createDeferred();
  const releaseBlocker = createDeferred();
  const releaseQueued = createDeferred();
  const queuedRequests: ProofModelRequest[] = [];
  const queuedAfterSourceCompletion: boolean[] = [];
  let blockerResult: Record<string, unknown> | undefined;
  let sourceCompleted = false;
  const script = createProofScript(marker);
  script.every(steerInput, (request) => {
    queuedRequests.push(request);
    queuedAfterSourceCompletion.push(sourceCompleted);
  });
  script.every(queuedPrompt, async (request) => {
    queuedRequests.push(request);
    queuedAfterSourceCompletion.push(sourceCompleted);
    queuedStarted.resolve();
    await releaseQueued.promise;
  });
  const blocker = script.every(blockerPrompt, async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  });
  const steeringSource = script.on(steerSourcePrompt, () =>
    proofSend(parent.result?.childSessionKey, steerInput, "steer"),
  );
  const parent = script.on(
    "",
    () => proofSpawn(blockerPrompt, { collect: true, groupId: marker }),
    async () => {
      blockerResult = parent.result;
      if (blockerResult?.status !== "accepted") {
        return undefined;
      }
      await blockerStarted.promise;
      return proofSpawn(queuedPrompt, { collect: true, groupId: marker });
    },
  );
  const previousSwarm = getRuntimeConfig().tools?.swarm;
  let source: ReturnType<typeof runProofIngress> | undefined;
  let queuedCompletion: Promise<RunResult> | undefined;
  let changedConfig = false;
  try {
    await patchProofConfig({ tools: { swarm: { enabled: true, maxConcurrent: 1 } } });
    changedConfig = true;
    source = run(sourcePrompt).then((result) => {
      sourceCompleted = true;
      return result;
    });
    await waitForProofGate(blockerStarted.promise, source, signal, "Collector did not start");
    await source;
    for (const accepted of [blockerResult, parent.result]) {
      expect(accepted).toMatchObject(acceptedSpawn);
    }
    expect(blocker.requests.length).toBeGreaterThan(0);
    expectToolAvailability(blocker.requests, "exec", true);
    expect(queuedRequests).toEqual([]);
    await updateSenderPolicies({ [`id:${marker}`]: { deny: ["exec"] } });
    queuedCompletion = waitForProofRun(parent.result?.runId);
    releaseBlocker.resolve();
    await waitForProofGate(
      queuedStarted.promise,
      queuedCompletion,
      signal,
      "Queued child did not start",
    );
    expectToolAvailability(queuedRequests, "exec", false);
    source = run(steerSourcePrompt);
    await steering.waitForAdmission(source, signal);
    releaseQueued.resolve();
    await source;
    expect(steeringSource.result).toMatchObject(acceptedSteer);
    expect(await queuedCompletion).toMatchObject({ status: "ok" });
    expect(await waitForProofRun(blockerResult?.runId)).toMatchObject({ status: "ok" });
    await expectProofIdle();
    expect(queuedRequests.some((request) => request.prompt.includes(steerInput))).toBe(true);
    expectToolAvailability(queuedRequests, "exec", false);
    expect(queuedAfterSourceCompletion).toEqual(queuedRequests.map(() => true));
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
  const run = createProofIngress(signal, marker);
  const spawnPrompt = `PROVENANCE_SOURCE_${marker}_spawn`;
  const sourceFollowupPrompt = `PROVENANCE_SOURCE_${marker}_followup`;
  const childPrompt = `PROVENANCE_TARGET_${marker}_initial`;
  const childFollowupPrompt = `PROVENANCE_TARGET_${marker}_followup`;
  const script = createProofScript(marker);
  const followup = script.on(childFollowupPrompt);
  const initial = script.on(childPrompt);
  const sourceFollowup = script.on(sourceFollowupPrompt, () =>
    proofSend(spawn.result?.childSessionKey, childFollowupPrompt, "followup"),
  );
  const spawn = script.on("", () => proofSpawn(childPrompt, { expectsCompletionMessage: false }));
  let changedPolicy = false;
  try {
    await run(spawnPrompt);
    expect(spawn.result).toMatchObject(acceptedSpawn);
    const initialCompletion = await waitForProofRun(spawn.result?.runId);
    expect(initialCompletion).toMatchObject({ status: "ok" });
    await waitForGatewayActiveWork(30_000);
    expect(initial.requests.length).toBeGreaterThan(0);
    expectToolAvailability(initial.requests, "exec", true);
    await updateSenderPolicies({ [`id:${marker}`]: { deny: ["exec"] } });
    changedPolicy = true;
    await run(sourceFollowupPrompt);
    expect(sourceFollowup.result).toMatchObject({
      status: "accepted",
      targetDisposition: "queued",
    });
    expect(await waitForProofRun(sourceFollowup.result?.runId)).toMatchObject({ status: "ok" });
    await expectProofIdle();
    expect(followup.requests.length).toBeGreaterThan(0);
    expectToolAvailability(followup.requests, "exec", false);
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
  const run = createProofIngress(signal, marker);
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
  using steering = await observeProofSteeringAdmission(compatibleInput);
  const started = createDeferred();
  const release = createDeferred();
  const script = createProofScript(marker);
  script.every(incumbentPrompt, async () => {
    started.resolve();
    await release.promise;
  });
  const restricted = script.on(restrictedPrompt, () =>
    proofSend(targetKey, restrictedInput, "steer"),
  );
  const compatibleSource = script.on(compatiblePrompt, () =>
    proofSend(targetKey, compatibleInput, "steer"),
  );
  script.on("");
  const requests = script.requests;
  const incumbent = run(incumbentPrompt);
  let compatible: ReturnType<typeof runProofIngress> | undefined;
  try {
    await waitForProofGate(started.promise, incumbent, signal, "DM did not start");
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
    await run(restrictedPrompt, {
      sessionKey: `agent:boundary:telegram:group:${groupId}`,
      groupId,
      to: groupId,
    });
    expect(
      requests.find((request) => request.prompt.includes(restrictedPrompt))?.tools,
      JSON.stringify({ groupId, result: restricted.result }),
    ).not.toContain("exec");
    expect.soft(restricted.result).toMatchObject({ status: "error" });
    expect.soft(restricted.result?.error).toMatch(/followup/);
    compatible = run(compatiblePrompt, {
      sessionKey: `agent:boundary:telegram:direct:${marker}-compatible`,
      to: `provenance-${marker}-compatible`,
    });
    await steering.waitForAdmission(compatible, signal);
    release.resolve();
    await compatible;
    expect(compatibleSource.result).toMatchObject(acceptedSteer);
    await incumbent;
    await expectProofIdle();
    expect(requests.some((request) => request.prompt.includes(restrictedInput))).toBe(false);
    expect(requests.some((request) => request.prompt.includes(compatibleInput))).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([incumbent, compatible]);
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
  const running: { alice?: ReturnType<typeof runHuman>; bob?: ReturnType<typeof runHuman> } = {};
  using steering = await observeProofSteeringAdmission(scenario.sourcePrompt);
  // Disposal retains a body failure when restoring config also fails.
  await using _ = {
    async [Symbol.asyncDispose]() {
      await settleProofScenario(scenario, [running.alice, running.bob]);
      await configureProofCollaboration(previousSetting);
    },
  };
  if (collaborative) {
    await gateway.client.request("sessions.create", {
      key: scenario.targetKey,
      agentId: "deployment",
    });
  }
  await configureProofCollaboration(
    allowCollaborativeSteering,
    allowCollaborativeSteering === true,
  );
  expect(getRuntimeConfig().messages?.queue?.allowCollaborativeSteering).toBe(
    allowCollaborativeSteering,
  );
  running.alice = runHuman(scenario, "alice", scenario.incumbentPrompt, "steer", signal).then(
    (result) => {
      scenario.incumbentCompleted = true;
      return result;
    },
  );
  await waitForProofGate(
    scenario.incumbentStarted.promise,
    running.alice,
    signal,
    "Alice settled before her first delivery",
  );
  running.bob = runHuman(
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
    await steering.waitForAdmission(running.bob, signal);
  } else if (allowCollaborativeSteering !== true) {
    expect(await running.bob).toMatchObject({ collaborativeSteeringRefused: true });
    expect(scenario.sourceRequests).toEqual([]);
    expect(scenario.incumbentCompleted).toBe(false);
    const followup = `/followup ${scenario.sourcePrompt}`;
    running.bob = runHuman(scenario, "bob", followup, "steer", signal, "text");
    expect((await running.bob).deferredToActiveRun).toBe("followup");
  } else {
    expect((await running.bob).deferredToActiveRun).toBe("followup");
  }
  const expectedReplies = collaborative
    ? []
    : (allowCollaborativeSteering === true
        ? [FOLLOWUP_REPLY]
        : [STEERING_REFUSED_REPLY, FOLLOWUP_REPLY]
      ).map((text) => ({ sender: "bob", text }));
  expect(humanReplies.slice(firstReply).filter((reply) => reply.sender === "bob")).toEqual(
    expectedReplies,
  );
  expect(scenario.incumbentCompleted).toBe(false);
  expect(scenario.sourceRequests).toEqual([]);
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
  scenario.releaseIncumbent.resolve();
  expect((await running.bob).deferredToActiveRun).toBe(collaborative ? "steer" : "followup");
  await running.alice;
  await expectProofIdle();
  expect(scenario.accepted).toMatchObject({ status: "accepted" });
  expectToolAvailability(scenario.incumbentRequests, "message", true);
  expect(scenario.targetRequests.length).toBeGreaterThan(0);
  expectToolAvailability(scenario.sourceRequests, "message", collaborative);
  expectToolAvailability(scenario.targetRequests, "message", collaborative);
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
  expect(proofDeliveries(scenario.recipient)).toEqual(
    collaborative ? sentMessage(scenario.recipient, scenario.marker) : [],
  );
  expect(
    outbound
      .filter((item) => item.to === `${scenario.recipient}-incumbent`)
      .map((item) => item.text),
  ).toEqual((collaborative ? [1] : [1, 2]).map((index) => `${scenario.marker}_INCUMBENT_${index}`));
}

// Share one test lifetime: global cleanup retires the Gateway's plugin owner after each test.
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
    const phases: ReadonlyArray<readonly [string, () => Promise<void>]> = [
      ["registered requester policy", () => verifyRegisteredRequesterPolicy(signal)],
      ["native spawn", () => verifyNativeSpawnRequester(signal, false)],
      ["native collector spawn", () => verifyNativeSpawnRequester(signal, true)],
      ["queued collector admission", () => verifyQueuedCollectorAdmission(signal)],
      ["completed child followup", () => verifyCompletedChildFollowup(signal)],
      ["steering policy compatibility", () => verifySteeringPolicyCompatibility(signal, false)],
      ["steering policy change", () => verifySteeringPolicyCompatibility(signal, true)],
      ["cross-human false", () => verifyCrossHumanAdmission(signal, false)],
      ["cross-human default", () => verifyCrossHumanAdmission(signal, undefined)],
      ["cross-human true", () => verifyCrossHumanAdmission(signal, true)],
      ["different-conversation input", () => verifyCrossHumanAdmission(signal, true, "different")],
      ["collaborative cancellation", () => verifyCollaborativeCancellation(signal)],
      ["linked principal final delivery", () => verifyLinkedPrincipalDelivery(signal)],
    ];
    for (const [name, run] of phases) {
      phase = name;
      await run();
    }
  },
);
