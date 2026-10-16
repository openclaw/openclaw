import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
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
import { createQueueCase } from "./queue.case.test-support.js";
import type { FollowupRun } from "./queue.js";
import { FollowupRunDeferredError } from "./queue.js";
import { createQueueTestRun, installQueueRuntimeErrorSilencer } from "./queue.test-helpers.js";
import { clearFollowupQueue } from "./queue/state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";
const queueKeys = new Set<string>();
const evidenceCleanups = new Set<() => void>();
function trackedQueue(...args: Parameters<typeof createQueueCase>) {
  const q = createQueueCase(...args);
  queueKeys.add(q.key);
  return q;
}
const image = (data: string, mimeType: string) => ({ type: "image" as const, data, mimeType });
const skill = (name: string, directory = name) => ({
  name,
  path: `/tmp/skills/${directory}/SKILL.md`,
});
const carrierRun = {
  provider: "openai",
  model: "gpt-route",
  memberRoleIds: ["operator", "member"],
  thinkLevelOverride: "high",
  fastModeOverride: true,
  verboseLevel: "on",
  reasoningLevel: "on",
  trustedInternalHandoff: {
    kind: "subagent-completion",
    sourceSessionKey: "agent:child",
    targetSessionKey: "agent:parent",
    targetSessionId: "session-1",
    provider: "openai",
    model: "gpt-route",
  },
  scheduledToolPolicy: { version: 1, mode: "trusted" },
  runtimePluginToolGrant: { pluginId: "workboard", toolNames: ["workboard_complete"] },
} satisfies Partial<FollowupRun["run"]>;
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
    run.images = [image("inline-png", "image/png")];
    run.imageOrder = ["offloaded", "inline"];
    run.media = [{ path: "/tmp/stored.png", contentType: "image/png" }, { kind: "image" }];
    const expectedMedia = structuredClone([run.prompt, run.images, run.imageOrder, run.media]);
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
    await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
    const toolAuthorityFingerprint = await operation.bindToolAuthorityRouteAsync({
      provider: run.run.provider,
      model: run.run.model,
    });
    const reject = vi.fn(async () => {
      throw new Error("no active turn to steer");
    });
    operation.attachBackend({
      kind: "embedded",
      supportsQueueMessageImages: true,
      toolAuthorityFingerprint,
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage: reject },
    });
    operation.setPhase("running");
    const runFollowup = vi
      .fn<(queued: FollowupRun) => Promise<void>>()
      .mockResolvedValue(undefined);
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
        }),
      ).resolves.toBe("handled");
      expect(reject).toHaveBeenCalledOnce();
      expect(persist).not.toHaveBeenCalled();
      operation.complete();
      await vi.waitFor(() => expect(runFollowup).toHaveBeenCalledOnce());
      const fallback = runFollowup.mock.calls[0]![0];
      expect([fallback.prompt, fallback.images, fallback.imageOrder, fallback.media]).toEqual(
        expectedMedia,
      );
      expect(fallback.userTurnTranscriptRecorder).toBe(recorder);
      expect(recorder.hasPersisted()).toBe(false);
    } finally {
      operation.complete();
      persist.mockRestore();
    }
  });

  it.each(["same", "mixed"] as const)(
    "keeps collected facts stable across deferred %s-participant admission",
    async (kind) => {
      const mixed = kind === "mixed";
      const audit = createChannelAdmissionAudit({ enabled: true });
      evidenceCleanups.add(() => audit.close());
      const q = trackedQueue({ mode: "collect", debounceMs: 0 }, 1);
      const turns = [
        ["a", "first", "/tmp/a.png", "image/png"],
        ["b", "second", "/tmp/b.pdf", "application/pdf"],
      ] as const;
      const media = turns.map((turn) => ({ path: turn[2], contentType: turn[3] }));
      for (const [skillName, label, path, contentType] of turns) {
        const prompt = `[media attached: ${path} (${contentType})]\n${label}`;
        const run = createQueueTestRun({ prompt });
        run.toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"], ["exec", "message"]]);
        run.disableTools = true;
        run.run = { ...run.run, ...structuredClone(carrierRun) };
        if (mixed) {
          Object.assign(run, { originatingChannel: "test", originatingTo: "room:shared" });
          Object.assign(run.run, {
            senderId: "ambiguous-transport-sender",
            senderName: "Ambiguous Sender",
            senderUsername: "ambiguous",
            senderE164: "+15550000000",
            senderIsOwner: true,
            traceAuthorized: true,
            ownerNumbers: ["+15550000000"],
          });
        }
        run.images = [image(path, contentType)];
        run.imageOrder = ["inline"];
        run.media = [{ path, contentType }];
        run.explicitSkillSelections = [
          skill(skillName),
          skill(`shared-${skillName === "a" ? "first" : "last"}`, "shared"),
        ];
        run.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
          audit,
          channelId: "test",
          participantId: mixed ? skillName : "person-1",
        });
        q.add(run);
      }
      q.start(async (run) => {
        q.calls.push(run);
        if (q.calls.length === 1) {
          throw new FollowupRunDeferredError();
        }
        q.done.resolve();
      });
      await q.done.promise;
      const senderSuffix = mixed ? " (from Ambiguous Sender)" : "";
      const expectedPrompt = [
        "[Queued messages while agent was busy]",
        ...turns.map(
          ([, label, path, type], i) =>
            `---\nQueued #${i + 1}${senderSuffix}\n[media attached: ${path} (${type})]\n${label}`,
        ),
      ].join("\n\n");
      expect(q.calls.map((run) => run.prompt)).toEqual([expectedPrompt, expectedPrompt]);
      for (const run of q.calls) {
        expect([run.media, run.images, run.imageOrder, run.toolsAllow, run.disableTools]).toEqual([
          media,
          media.map(({ path, contentType }) => image(path, contentType)),
          ["inline", "inline"],
          ["exec"],
          true,
        ]);
        expect(run.explicitSkillSelections).toEqual([
          skill("a"),
          skill("shared-last", "shared"),
          skill("b"),
        ]);
        expect(run.toolsAllow ? readToolAllowlistIntersection(run.toolsAllow) : undefined).toEqual([
          ["exec"],
          ["exec", "message"],
        ]);
        expect(run.run).toMatchObject(carrierRun);
        if (mixed) {
          expect(run.run).toMatchObject({
            senderId: undefined,
            senderName: undefined,
            senderUsername: undefined,
            senderE164: undefined,
            senderIsOwner: false,
            traceAuthorized: false,
            ownerNumbers: [],
          });
        }
      }
      if (kind === "same") {
        expect(
          compareChannelAdmissionParticipants(q.calls.map((run) => run.channelAdmissionEvidence)),
        ).toBe("same");
      }
      expect(consumeChannelAdmissionEvidence(q.calls[1]?.channelAdmissionEvidence)).toMatchObject(
        kind === "same"
          ? { ingressState: "present", invoker: { state: "present", kind: "person" } }
          : { ingressState: "unknown", invoker: { state: "unknown" } },
      );
    },
  );

  it.each([
    { name: "trace", first: { traceLevelOverride: "off" }, second: { traceLevelOverride: "raw" } },
    { name: "thinking", first: { thinkLevel: "low" }, second: { thinkLevel: "high" } },
    {
      name: "fast auto duration",
      first: { fastMode: "auto", fastModeAutoOnSeconds: 30, fastModeAutoOnSecondsOverride: true },
      second: { fastMode: "auto", fastModeAutoOnSeconds: 120, fastModeAutoOnSecondsOverride: true },
    },
  ] as const)(
    "keeps conflicting turn $name choices in separate collected replies",
    async ({ first, second }) => {
      const q = trackedQueue({ cap: 20 }, 3);
      for (const [index, settings] of [first, second, second, first].entries()) {
        q.enqueue(
          { prompt: `task ${index}`, messageId: `choice-${index}` },
          { traceAuthorized: true, ...settings },
        );
      }
      await q.drain();
      expect(q.calls).toHaveLength(3);
      expect(q.calls.map((run) => run.run)).toMatchObject([first, second, first]);
      for (const [index, texts] of [
        [0, ["task 0"]],
        [1, ["task 1", "task 2"]],
        [2, ["task 3"]],
      ] as const) {
        for (const text of texts) {
          expect(q.calls[index]?.prompt).toContain(text);
        }
      }
    },
  );
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
  function expectAdmission(profileId?: string) {
    expect(admissions).toMatchObject([
      {
        kind: "capture",
        envelope: {
          ingress: {
            kind: "gateway-client",
            boundary: "gateway.ws.authenticated-connect",
            state: profileId ? "present" : "unknown",
            ...(profileId ? { rawSourceRef: profileId } : {}),
          },
          invoker: profileId
            ? { state: "present", kind: "person", rawPrincipalRef: profileId }
            : { state: "unknown" },
          assurance: profileId
            ? [
                {
                  kind: "durable-profile",
                  rawEvidenceRef: profileId,
                  strength: "boundary-verified",
                },
              ]
            : expect.not.arrayContaining([expect.objectContaining({ kind: "durable-profile" })]),
        },
      },
    ]);
  }
  it.each(["matching", "mixed"] as const)(
    "collects %s attach snapshots without changing sender authority",
    async (kind) => {
      const q = trackedQueue({ cap: 20 });
      for (const index of [0, 1]) {
        const run = createQueueTestRun({ prompt: `queued ${index}` });
        run.gatewayLocalUserIngress = prepareIngress(
          kind === "mixed" && index === 1 ? "person-2" : "person-1",
        );
        run.run = { ...run.run, senderId: "transport", senderIsOwner: true };
        q.add(run);
      }
      await q.drain();
      const collected = q.calls[0]!;
      expect(collected.prompt).toContain("queued 0");
      expect(collected.prompt).toContain("queued 1");
      await admit(collected);
      expectAdmission(kind === "matching" ? "person-1" : undefined);
      expect(collected.run).toMatchObject({ senderId: "transport", senderIsOwner: true });
    },
  );

  it("retains the original attach snapshot when overflow delivery retries after profile replacement", async () => {
    const q = trackedQueue({ mode: "collect", debounceMs: 0, cap: 1, dropPolicy: "summarize" }, 1);
    const client = {};
    attachGatewayLocalUserIngress(client, prepareIngress("original-person"));
    const source = createQueueTestRun({ prompt: "overflow source" });
    source.gatewayLocalUserIngress = getGatewayLocalUserIngress(client);
    q.add(source);
    q.add(createQueueTestRun({ prompt: "surviving source" }));
    let attempts = 0;
    q.start(async (run) => {
      if (!run.prompt.includes("overflow source")) {
        q.done.resolve();
        return;
      }
      attempts += 1;
      if (attempts === 1) {
        attachGatewayLocalUserIngress(client, prepareIngress("replacement-person"));
        throw new Error("Synthetic pre-admission delivery failure");
      }
      await admit(run);
    });
    await q.done.promise;
    expect(attempts).toBe(2);
    expect(admissions).toHaveLength(1);
    expectAdmission("original-person");
  });
});
