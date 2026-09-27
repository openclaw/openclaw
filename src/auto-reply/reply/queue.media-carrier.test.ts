// Prompt metadata carrier tests cover collect batching, deferral, and retry identity.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  attachToolAllowlistIntersection,
  readToolAllowlistIntersection,
} from "../../agents/tool-policy.js";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../../audit/execution-identity-admission.js";
import {
  compareChannelAdmissionParticipants,
  createChannelAdmissionAudit,
  consumeChannelAdmissionEvidence,
} from "../../channels/message-access/admission-evidence.js";
import {
  attachGatewayLocalUserIngress,
  getGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "../../gateway/local-user-ingress.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, FollowupRunDeferredError, scheduleFollowupDrain } from "./queue.js";
import { createQueueTestRun, installQueueRuntimeErrorSilencer } from "./queue.test-helpers.js";
import {
  createOverflowSummaryRetrySource,
  resolveFollowupDeliveryContextKey,
} from "./queue/delivery-context.js";
import { clearFollowupQueue } from "./queue/state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

const queueKeys = new Set<string>();
const evidenceCleanups = new Set<() => void>();

function addCombinedCarrierFacts(run: FollowupRun): void {
  run.toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"], ["exec", "message"]]);
  run.disableTools = true;
  run.run = {
    ...run.run,
    provider: "openai",
    model: "gpt-route",
    memberRoleIds: ["operator", "member"],
    trustedInternalHandoff: {
      kind: "subagent-completion",
      sourceSessionKey: "agent:child",
      targetSessionKey: "agent:parent",
      targetSessionId: "session-1",
      provider: "openai",
      model: "gpt-route",
    },
    scheduledToolPolicy: { version: 1, mode: "trusted" },
    runtimePluginToolGrant: {
      pluginId: "workboard",
      toolNames: ["workboard_complete"],
    },
  };
}

function expectCombinedCarrierFacts(run: FollowupRun | undefined): void {
  expect(run).toBeDefined();
  expect(run?.toolsAllow).toEqual(["exec"]);
  expect(run?.toolsAllow ? readToolAllowlistIntersection(run.toolsAllow) : undefined).toEqual([
    ["exec"],
    ["exec", "message"],
  ]);
  expect(run?.disableTools).toBe(true);
  expect(run?.run).toMatchObject({
    provider: "openai",
    model: "gpt-route",
    memberRoleIds: ["operator", "member"],
    trustedInternalHandoff: {
      kind: "subagent-completion",
      sourceSessionKey: "agent:child",
      targetSessionKey: "agent:parent",
      targetSessionId: "session-1",
      provider: "openai",
      model: "gpt-route",
    },
    scheduledToolPolicy: { version: 1, mode: "trusted" },
    runtimePluginToolGrant: {
      pluginId: "workboard",
      toolNames: ["workboard_complete"],
    },
  });
}

afterEach(() => {
  for (const key of queueKeys) {
    clearFollowupQueue(key);
  }
  queueKeys.clear();
  for (const cleanup of evidenceCleanups) {
    cleanup();
  }
  evidenceCleanups.clear();
});

describe("followup prompt metadata carrier", () => {
  it("drains the complete parked image turn after active steering rejects it", async () => {
    const key = "agent:main:parked-media-fallback";
    queueKeys.add(key);
    const run = createQueueTestRun({
      prompt: "  preserve this caption\n",
      messageId: "media-fallback",
    });
    run.images = [{ type: "image", data: "inline-png", mimeType: "image/png" }];
    run.imageOrder = ["offloaded", "inline"];
    run.media = [{ path: "/tmp/stored.png", contentType: "image/png" }, { kind: "image" }];
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: run.prompt, media: run.media },
      target: () => undefined,
    });
    run.userTurnTranscriptRecorder = recorder;
    const persist = vi.spyOn(recorder, "persistApproved");
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: run.run.sessionId,
      resetTriggered: false,
    });
    operation.bindToolAuthoritySnapshot({
      fingerprint: () => "media-authority",
      project: () => "media-authority",
    });
    const reject = vi.fn(async () => {
      throw new Error("no active turn to steer");
    });
    operation.attachBackend({
      kind: "embedded",
      supportsQueueMessageImages: true,
      toolAuthorityFingerprint: "media-authority",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage: reject },
    });
    operation.setPhase("running");
    const delivered = createDeferred<FollowupRun>();
    const runFollowup = vi.fn(async (queued: FollowupRun) => {
      delivered.resolve(queued);
    });
    const typing = createMockTypingController();
    try {
      await expect(
        runActiveReplySteer({
          followupRun: run,
          opts: undefined,
          providedReplyOperation: operation,
          queueKey: key,
          releaseAdmissionTicket: vi.fn(),
          replyOperationRunState: undefined,
          resolvedQueue: { mode: "steer", debounceMs: 0 },
          restartRecoverySourceTurnId: "media-fallback",
          runFollowup,
          sessionCtx: {},
          sessionKey: key,
          touchActiveSessionEntry: async () => {},
          typing,
          typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
          toolAuthorityFingerprint: "media-authority",
        }),
      ).resolves.toBe("handled");
      expect(reject).toHaveBeenCalledOnce();
      expect(persist).not.toHaveBeenCalled();
      operation.complete();
      await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledOnce());
      const fallback = await delivered.promise;
      expect({
        text: fallback.prompt,
        images: fallback.images,
        imageOrder: fallback.imageOrder,
        media: fallback.media,
      }).toEqual({
        text: "  preserve this caption\n",
        images: [{ type: "image", data: "inline-png", mimeType: "image/png" }],
        imageOrder: ["offloaded", "inline"],
        media: [{ path: "/tmp/stored.png", contentType: "image/png" }, { kind: "image" }],
      });
      expect(fallback.userTurnTranscriptRecorder).toBe(recorder);
      expect(recorder.hasPersisted()).toBe(false);
    } finally {
      operation.complete();
      persist.mockRestore();
    }
  });

  it("keeps participant evidence out of sender-scoped collect routing", () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    evidenceCleanups.add(() => audit.close());
    const runs = ["person-1", "person-2"].map((senderId) => {
      const item = createQueueTestRun({
        prompt: `from ${senderId}`,
        originatingChannel: "slack",
        originatingTo: "channel:A",
      });
      item.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
        audit,
        channelId: "slack",
        accountId: "default",
        participantId: senderId,
      });
      item.run = {
        ...item.run,
        senderId,
        senderE164: `+1555000${senderId.at(-1)}`,
        senderIsOwner: false,
      };
      return item;
    });

    expect(resolveFollowupDeliveryContextKey(runs[0]!)).not.toBe(
      resolveFollowupDeliveryContextKey(runs[1]!),
    );
  });
  it("keeps collected prompt bytes and ordered facts stable across deferred admission", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    evidenceCleanups.add(() => audit.close());
    const key = `prompt-media-collect-${Date.now()}`;
    queueKeys.add(key);
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };
    const done = createDeferred();
    const calls: FollowupRun[] = [];

    for (const [prompt, path, contentType, skillName, sharedSkillName] of [
      [
        "[media attached: /tmp/a.png (image/png)]\nfirst",
        "/tmp/a.png",
        "image/png",
        "a",
        "shared-first",
      ],
      [
        "[media attached: /tmp/b.pdf (application/pdf)]\nsecond",
        "/tmp/b.pdf",
        "application/pdf",
        "b",
        "shared-last",
      ],
    ] as const) {
      const run = createQueueTestRun({ prompt });
      addCombinedCarrierFacts(run);
      run.images = [{ type: "image", data: path, mimeType: contentType }];
      run.imageOrder = ["inline"];
      run.media = [{ path, contentType }];
      run.explicitSkillSelections = [
        { name: skillName, path: `/tmp/skills/${skillName}/SKILL.md` },
        { name: sharedSkillName, path: "/tmp/skills/shared/SKILL.md" },
      ];
      run.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
        audit,
        channelId: "test",
        participantId: "person-1",
      });
      enqueueFollowupRun(key, run, settings);
    }

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        throw new FollowupRunDeferredError();
      }
      done.resolve();
    });
    await done.promise;

    const expectedPrompt = [
      "[Queued messages while agent was busy]",
      "---\nQueued #1\n[media attached: /tmp/a.png (image/png)]\nfirst",
      "---\nQueued #2\n[media attached: /tmp/b.pdf (application/pdf)]\nsecond",
    ].join("\n\n");
    expect(calls.map((run) => run.prompt)).toEqual([expectedPrompt, expectedPrompt]);
    expect(calls.map((run) => run.media)).toEqual([
      [
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.pdf", contentType: "application/pdf" },
      ],
      [
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.pdf", contentType: "application/pdf" },
      ],
    ]);
    expect(calls.map((run) => run.images)).toEqual([
      [
        { type: "image", data: "/tmp/a.png", mimeType: "image/png" },
        { type: "image", data: "/tmp/b.pdf", mimeType: "application/pdf" },
      ],
      [
        { type: "image", data: "/tmp/a.png", mimeType: "image/png" },
        { type: "image", data: "/tmp/b.pdf", mimeType: "application/pdf" },
      ],
    ]);
    expect(calls.map((run) => run.imageOrder)).toEqual([
      ["inline", "inline"],
      ["inline", "inline"],
    ]);
    const expectedSkills = [
      { name: "a", path: "/tmp/skills/a/SKILL.md" },
      { name: "shared-last", path: "/tmp/skills/shared/SKILL.md" },
      { name: "b", path: "/tmp/skills/b/SKILL.md" },
    ];
    expect(calls.map((run) => run.explicitSkillSelections)).toEqual([
      expectedSkills,
      expectedSkills,
    ]);
    for (const call of calls) {
      expectCombinedCarrierFacts(call);
    }
    expect(
      compareChannelAdmissionParticipants(calls.map((run) => run.channelAdmissionEvidence)),
    ).toBe("same");
    expect(consumeChannelAdmissionEvidence(calls[1]?.channelAdmissionEvidence)).toMatchObject({
      ingressState: "present",
      invoker: { state: "present", kind: "person" },
    });
  });

  it.each([
    { name: "trace", first: { traceLevelOverride: "off" }, second: { traceLevelOverride: "raw" } },
    { name: "thinking", first: { thinkLevel: "low" }, second: { thinkLevel: "high" } },
    {
      name: "original thinking",
      first: { thinkLevel: "off", thinkLevelOverride: "high" },
      second: { thinkLevel: "off", thinkLevelOverride: "off" },
    },
    { name: "fast", first: { fastMode: false }, second: { fastMode: true } },
    {
      name: "fast preference source",
      first: { fastMode: true, fastModeOverride: false },
      second: { fastMode: true, fastModeOverride: true },
    },
    {
      name: "fast auto duration source",
      first: { fastMode: "auto", fastModeAutoOnSeconds: 30, fastModeAutoOnSecondsOverride: false },
      second: { fastMode: "auto", fastModeAutoOnSeconds: 30, fastModeAutoOnSecondsOverride: true },
    },
    {
      name: "fast auto duration",
      first: { fastMode: "auto", fastModeAutoOnSeconds: 30, fastModeAutoOnSecondsOverride: true },
      second: { fastMode: "auto", fastModeAutoOnSeconds: 120, fastModeAutoOnSecondsOverride: true },
    },
    { name: "verbose", first: { verboseLevel: "off" }, second: { verboseLevel: "on" } },
    { name: "reasoning", first: { reasoningLevel: "off" }, second: { reasoningLevel: "on" } },
  ] as const)(
    "keeps conflicting turn $name choices in separate collected replies",
    async ({ name, first, second }) => {
      const key = `turn-choice-collect-${name}`;
      queueKeys.add(key);
      const done = createDeferred();
      const calls: FollowupRun[] = [];
      for (const [index, settings] of [first, second, second, first].entries()) {
        const run = createQueueTestRun({ prompt: `task ${index}`, messageId: `choice-${index}` });
        run.run = { ...run.run, traceAuthorized: true, ...settings };
        enqueueFollowupRun(key, run, { mode: "collect", debounceMs: 0 });
      }
      scheduleFollowupDrain(key, async (run) => {
        calls.push(run);
        if (run.prompt.includes("task 3")) {
          done.resolve();
        }
      });
      await done.promise;
      expect(calls).toHaveLength(3);
      expect(calls[0]?.run).toMatchObject(first);
      expect(calls[1]?.run).toMatchObject(second);
      expect(calls[2]?.run).toMatchObject(first);
      expect(calls[0]?.prompt).toContain("task 0");
      expect(calls[1]?.prompt).toContain("task 1");
      expect(calls[1]?.prompt).toContain("task 2");
      expect(calls[2]?.prompt).toContain("task 3");
    },
  );

  it("removes sender authority when collected evidence identifies mixed participants", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    evidenceCleanups.add(() => audit.close());
    const key = `prompt-metadata-mixed-${Date.now()}`;
    queueKeys.add(key);
    const done = createDeferred();
    const calls: FollowupRun[] = [];

    for (const [participantId, skillName] of [
      ["person-1", "a"],
      ["person-2", "b"],
    ] as const) {
      const run = createQueueTestRun({
        prompt: `from ${participantId}`,
        originatingChannel: "test",
        originatingTo: "room:shared",
      });
      addCombinedCarrierFacts(run);
      run.explicitSkillSelections = [
        { name: skillName, path: `/tmp/skills/${skillName}/SKILL.md` },
      ];
      run.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
        audit,
        channelId: "test",
        participantId,
      });
      run.run = {
        ...run.run,
        senderId: "ambiguous-transport-sender",
        senderName: "Ambiguous Sender",
        senderUsername: "ambiguous",
        senderE164: "+15550000000",
        senderIsOwner: true,
        traceAuthorized: true,
        ownerNumbers: ["+15550000000"],
      };
      enqueueFollowupRun(key, run, { mode: "collect", debounceMs: 0 });
    }

    scheduleFollowupDrain(key, async (run) => {
      calls.push(run);
      done.resolve();
    });
    await done.promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.explicitSkillSelections).toEqual([
      { name: "a", path: "/tmp/skills/a/SKILL.md" },
      { name: "b", path: "/tmp/skills/b/SKILL.md" },
    ]);
    expect(consumeChannelAdmissionEvidence(calls[0]?.channelAdmissionEvidence)).toMatchObject({
      ingressState: "unknown",
      invoker: { state: "unknown" },
    });
    expect(calls[0]?.run).toMatchObject({
      senderId: undefined,
      senderName: undefined,
      senderUsername: undefined,
      senderE164: undefined,
      senderIsOwner: false,
      traceAuthorized: false,
      ownerNumbers: [],
    });
    expectCombinedCarrierFacts(calls[0]);
  });

  it("preserves facts when an overflow source is rebuilt for retry", () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    evidenceCleanups.add(() => audit.close());
    const source = createQueueTestRun({
      prompt: "[media attached: /tmp/retry.png (image/png)]\nretry me",
    });
    addCombinedCarrierFacts(source);
    source.images = [{ type: "image", data: "png", mimeType: "image/png" }];
    source.imageOrder = ["offloaded"];
    source.media = [{ path: "/tmp/retry.png", contentType: "image/png" }];
    source.explicitSkillSelections = [{ name: "retry", path: "/tmp/skills/retry/SKILL.md" }];
    source.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
      audit,
      channelId: "test",
      participantId: "person-1",
    });

    const retry = createOverflowSummaryRetrySource(source);

    expect(retry.prompt).toBe(source.prompt);
    expect(retry.images).toEqual(source.images);
    expect(retry.imageOrder).toEqual(source.imageOrder);
    expect(retry.media).toEqual(source.media);
    expect(retry.explicitSkillSelections).toEqual(source.explicitSkillSelections);
    expect(retry.channelAdmissionEvidence).toBe(source.channelAdmissionEvidence);
    expectCombinedCarrierFacts(retry);
  });
});

describe("queued Gateway attach evidence", () => {
  installQueueRuntimeErrorSilencer();
  const admissions: ExecutionIdentityAdmissionWork[] = [];

  beforeEach(() => {
    admissions.length = 0;
    evidenceCleanups.add(
      configureExecutionIdentityAdmissionSink((work) => {
        admissions.push(work);
        return true;
      }),
    );
  });

  async function admit(run: FollowupRun) {
    const prepared = prepareChannelRunAdmission({
      cfg: { logging: { audit: { executionIdentity: true } } },
      runId: "queued-attach",
      agentId: "main",
      ingressKind: "channel",
      boundary: "auto-reply.agent-runner",
      evidence: run.channelAdmissionEvidence,
      gatewayLocalUserIngress: run.gatewayLocalUserIngress,
    });
    try {
      await prepared.admit("embedded");
    } finally {
      prepared.close();
    }
  }

  const prepareIngress = (profileId: string) =>
    prepareGatewayLocalUserIngress({
      authMethod: "token",
      authenticatedUserExpected: true,
      profile: { profileId },
      isLocalClient: false,
    });

  it.each(["matching", "mixed", "missing"] as const)(
    "collects %s attach snapshots without changing sender authority",
    async (kind) => {
      const key = `gateway-attach-collect-${kind}`;
      queueKeys.add(key);
      const done = createDeferred<FollowupRun>();
      for (const index of [0, 1]) {
        const run = createQueueTestRun({ prompt: `queued ${index}` });
        run.gatewayLocalUserIngress =
          kind === "missing" && index === 1
            ? undefined
            : prepareIngress(kind === "mixed" && index === 1 ? "person-2" : "person-1");
        run.run = { ...run.run, senderId: "transport", senderIsOwner: true };
        enqueueFollowupRun(key, run, { mode: "collect", debounceMs: 0 });
      }
      scheduleFollowupDrain(key, async (run) => {
        done.resolve(run);
      });
      const collected = await done.promise;
      expect(collected.prompt).toContain("queued 0");
      expect(collected.prompt).toContain("queued 1");
      await admit(collected);
      expect(admissions).toMatchObject([
        {
          kind: "capture",
          envelope:
            kind === "matching"
              ? {
                  ingress: {
                    kind: "gateway-client",
                    boundary: "gateway.ws.authenticated-connect",
                    state: "present",
                    rawSourceRef: "person-1",
                  },
                  invoker: { state: "present", kind: "person", rawPrincipalRef: "person-1" },
                  assurance: [
                    {
                      kind: "durable-profile",
                      rawEvidenceRef: "person-1",
                      strength: "boundary-verified",
                    },
                  ],
                }
              : {
                  ingress: {
                    kind: "gateway-client",
                    boundary: "gateway.ws.authenticated-connect",
                    state: "unknown",
                  },
                  invoker: { state: "unknown" },
                },
        },
      ]);
      const captured = admissions[0];
      if (kind !== "matching" && captured?.kind === "capture") {
        expect(captured.envelope.assurance).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: "durable-profile" })]),
        );
      }
      expect(collected.run).toMatchObject({ senderId: "transport", senderIsOwner: true });
    },
  );

  it("retains the original attach snapshot when overflow delivery retries after profile replacement", async () => {
    const key = "gateway-attach-overflow-retry";
    queueKeys.add(key);
    const client = {};
    attachGatewayLocalUserIngress(client, prepareIngress("original-person"));
    const source = createQueueTestRun({ prompt: "overflow source" });
    source.gatewayLocalUserIngress = getGatewayLocalUserIngress(client);
    const settings: QueueSettings = {
      mode: "collect",
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize",
    };
    enqueueFollowupRun(key, source, settings);
    enqueueFollowupRun(key, createQueueTestRun({ prompt: "surviving source" }), settings);
    const done = createDeferred();
    let attempts = 0;
    scheduleFollowupDrain(key, async (run) => {
      if (!run.prompt.includes("overflow source")) {
        done.resolve();
        return;
      }
      attempts += 1;
      if (attempts === 1) {
        attachGatewayLocalUserIngress(client, prepareIngress("replacement-person"));
        throw new Error("Synthetic pre-admission delivery failure");
      }
      await admit(run);
    });
    await done.promise;

    expect(attempts).toBe(2);
    expect(admissions).toHaveLength(1);
    expect(admissions).toMatchObject([
      {
        kind: "capture",
        envelope: {
          ingress: { kind: "gateway-client", state: "present", rawSourceRef: "original-person" },
          invoker: { state: "present", kind: "person", rawPrincipalRef: "original-person" },
          assurance: [{ kind: "durable-profile", rawEvidenceRef: "original-person" }],
        },
      },
    ]);
  });
});
