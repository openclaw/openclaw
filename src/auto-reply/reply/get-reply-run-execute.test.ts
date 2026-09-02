import { describe, expect, it } from "vitest";
import { shouldAdmitFreshChannelOwnerCronAuthority } from "../../agents/cron-creator-authority-context.js";
import { registerProducedStagingDirectory } from "../../media/staged-inputs.js";
import type { PreparedReplyRunAdmission } from "./get-reply-run-admission.js";
import { executePreparedReplyRun } from "./get-reply-run-execute.js";

const BASE = {
  senderIsOwner: true,
  messageProvider: "telegram",
  senderId: "owner-1",
  isHeartbeat: false,
  isRoomEvent: false,
};

describe("fresh channel owner cron authority admission", () => {
  it.each(["telegram", "discord", "slack", "custom-channel"])(
    "admits an authenticated direct owner turn from %s without channel-specific policy",
    (messageProvider) => {
      expect(shouldAdmitFreshChannelOwnerCronAuthority({ ...BASE, messageProvider })).toBe(true);
    },
  );

  it.each([
    { name: "non-owner", overrides: { senderIsOwner: false } },
    { name: "missing provider", overrides: { messageProvider: undefined } },
    { name: "missing sender", overrides: { senderId: undefined } },
    { name: "heartbeat", overrides: { isHeartbeat: true } },
    { name: "room event", overrides: { isRoomEvent: true } },
    { name: "continuation provenance", overrides: { inputProvenance: { kind: "continuation" } } },
    { name: "spawned session", overrides: { spawnedBy: "agent:parent" } },
    { name: "replayed turn", overrides: { suppressNextUserMessagePersistence: true } },
  ])("rejects $name", ({ overrides }) => {
    expect(shouldAdmitFreshChannelOwnerCronAuthority({ ...BASE, ...overrides })).toBe(false);
  });
});

describe("executePreparedReplyRun staging lifecycle handoff", () => {
  it("carries hostWorkspaceStagingDir from opts into the production followupRun", async () => {
    let capturedFollowupRun: any = undefined;
    const stagingDir = "/tmp/openclaw-staged-12345678-1234-4234-8234-1234567890ab";
    registerProducedStagingDirectory(stagingDir);

    const mockState = {
      context: {
        params: {
          ctx: {
            SenderId: "test-sender",
            SenderDisplay: "test",
            Body: "test",
          },
          sessionCtx: {
            SenderId: "test-sender",
            SenderDisplay: "test",
          },
          cfg: {},
          agentId: "test-agent",
          agentDir: "/tmp",
          agentCfg: {},
          command: { commandBodyNormalized: "test" },
          provider: "telegram",
          model: "test-model",
          requestedRouteResolution: {},
          typing: {},
          opts: {
            hostWorkspaceStagingDir: stagingDir,
          },
        },
        resolvedVerboseLevel: "off",
        resolvedReasoningLevel: "off",
        resolvedElevatedLevel: "off",
        execOverrides: {},
        elevatedEnabled: false,
        elevatedAllowed: false,
        traceRunPhase: async (name: string, fn: any) => (typeof fn === "function" ? fn() : fn),
        promptSessionCtx: {},
        fullAccessState: { available: true },
        extraSystemPromptParts: [],
      },
      resolvedThinkLevel: "off",
      thinkingCatalog: {},
      skillsSnapshot: {},
      prefixedCommandBody: "test",
      queuedBody: "test",
      transcriptBody: "test",
      transcriptCommandBody: "test",
      promptMedia: [],
      currentInboundContext: undefined,
      isRoomEvent: false,
      providedReplyOperation: undefined,
      preparedSessionState: { sessionFile: { id: "test" } },
      resolvedQueue: {
        admissionState: "admitted",
        onAdmittedQueueEmpty: () => {},
      },
      embeddedAgentRuntime: {},
      resolveActiveEmbeddedSessionId: () => undefined,
      resolvePreparedSessionState: () => ({ sessionFile: { id: "test" } }),
      runReplyAgent: async (
        args: Parameters<typeof import("./agent-runner.js").runReplyAgent>[0],
      ) => {
        capturedFollowupRun = args.followupRun;
        return undefined as never;
      },
      queueKey: "queue-1",
      shouldSteer: false,
      shouldFollowup: false,
      queueAdmissionState: undefined,
      isActive: () => true,
      authProfileId: undefined,
      authProfileIdSource: undefined,
    } as unknown as PreparedReplyRunAdmission;

    await executePreparedReplyRun(mockState);

    expect(capturedFollowupRun).toBeDefined();
    expect(capturedFollowupRun.hostWorkspaceStagingDir).toBe(stagingDir);
  });
});
