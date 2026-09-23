import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { attachToolAllowlistIntersection } from "../../agents/tool-policy.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import type { ReplyToolAuthorityOverlay } from "./reply-run-registry.contracts.js";
import type { ReplyBackendQueueMessageOptions } from "./reply-run-registry.js";
import {
  createTestReplyOperation,
  queueCurrentReplyRunMessage,
} from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";
import {
  prepareReplyToolAuthority,
  resolveFollowupRunToolAuthorityFingerprint,
} from "./reply-tool-authority.js";

function toolAuthorityOverlay(
  run: ReturnType<typeof createQueueTestRun>,
): ReplyToolAuthorityOverlay {
  return {
    operatorAuthority: run.operatorAuthority,
    permissionMode: run.run.permissionMode,
    toolOverrides: run.run.toolOverrides,
    originatingChannel: run.originatingChannel,
    messageProvider: run.run.messageProvider,
    chatType: run.run.chatType,
    agentAccountId: run.run.agentAccountId,
    conversationToolPolicy: run.run.conversationToolPolicy,
    groupId: run.run.groupId,
    groupChannel: run.run.groupChannel,
    groupSpace: run.run.groupSpace,
    memberRoleIds: run.run.memberRoleIds,
    spawnedBy: run.run.spawnedBy,
    senderId: run.run.senderId,
    senderName: run.run.senderName,
    senderUsername: run.run.senderUsername,
    senderE164: run.run.senderE164,
    senderIsOwner: run.run.senderIsOwner === true,
    inputProvenance: run.run.inputProvenance,
    trustedInternalHandoff: run.run.trustedInternalHandoff,
    scheduledToolPolicy: run.run.scheduledToolPolicy,
    runtimePluginToolGrant: run.run.runtimePluginToolGrant,
    toolsAllow: run.toolsAllow,
    disableTools: run.disableTools === true,
    traceAuthorized: run.run.traceAuthorized === true,
    approvalReviewerDeviceId: run.run.approvalReviewerDeviceId,
    clientCaps: run.run.clientCaps,
    gatewayUiCommandTarget: run.run.gatewayUiCommandTarget,
    toolBindings: run.run.toolBindings,
  };
}

describe("reply tool authority", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
  });

  it.each(["agent:agent:main", "global"])(
    "distinguishes hidden allowlist intersections in steering authority for %s",
    (sessionKey) => {
      const first = createQueueTestRun({ prompt: "first" });
      const second = createQueueTestRun({ prompt: "second" });
      for (const run of [first, second]) {
        run.run.sessionKey = sessionKey;
        run.run.config = { agents: { ownership: "explicit", entries: { agent: {}, other: {} } } };
      }
      first.toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"]]);
      second.toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"], ["message"]]);

      expect(resolveFollowupRunToolAuthorityFingerprint(first)).not.toBe(
        resolveFollowupRunToolAuthorityFingerprint(second),
      );
    },
  );

  it.each(["other-participant", undefined])(
    "steers participant %s without replacing session personal context",
    async (participant) =>
      withOpenClawTestState({ scenario: "minimal" }, async () => {
        const owner = ensureProfileForEmail("owner@example.test");
        const other = ensureProfileForEmail("participant@example.test");
        const participantId = participant ? other.id : undefined;
        const run = createQueueTestRun({ prompt: "Session owner's turn" });
        run.run.bootstrapUserProfileId = owner.id;
        run.run.senderId = "first-participant";
        run.run.permissionMode = "full";
        run.operatorAuthority = createAdmittedRunOperatorAuthority({
          profileId: "original-operator",
          scopes: ["operator.read", "operator.write"],
          source: {},
          assertCurrent: () => {},
        });
        const operation = createTestReplyOperation({ sessionId: "personal-steering" });
        operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
        const fingerprint = operation.bindToolAuthorityRoute(run.run);
        const queueMessage = vi.fn(
          async (_text: string, _options?: ReplyBackendQueueMessageOptions) => {},
        );
        operation.attachBackend({
          kind: "embedded",
          cancel: vi.fn(),
          isStreaming: () => true,
          queueMessage,
        });
        operation.setPhase("running");
        const incoming = {
          ...run,
          run: { ...run.run, senderId: participantId, bootstrapUserProfileId: participantId },
        };
        // An owner reassignment can update the next turn's bootstrap selection,
        // but it is not a permission change and must not rewrite the active turn.
        expect(resolveFollowupRunToolAuthorityFingerprint(incoming)).toBe(fingerprint);
        for (const options of [
          { toolAuthorityFingerprint: resolveFollowupRunToolAuthorityFingerprint(incoming) },
          { toolAuthorityOverlay: toolAuthorityOverlay(incoming) },
        ]) {
          await expect(
            queueCurrentReplyRunMessage("personal-steering", "new turn", {
              isInboundUserMessage: true,
              ...options,
            }),
          ).resolves.toMatchObject({ status: "accepted" });
        }
        expect(queueMessage).toHaveBeenCalledTimes(2);
        for (const [, options] of queueMessage.mock.calls) {
          expect(options).not.toHaveProperty("bootstrapUserProfileId");
          expect(options).not.toHaveProperty("toolAuthorityOverlay");
        }
        expect(run.run.bootstrapUserProfileId).toBe(owner.id);
        expect(incoming.run.bootstrapUserProfileId).toBe(participantId);
        expect(operation.toolAuthorityFingerprint).toBe(fingerprint);

        for (const changed of [
          { permissionMode: "guarded" },
          { toolOverrides: { webSearch: false } },
          { operatorAuthority: undefined },
          {
            operatorAuthority: createAdmittedRunOperatorAuthority({
              ...run.operatorAuthority,
              source: {},
            }),
          },
          {
            operatorAuthority: createAdmittedRunOperatorAuthority({
              ...run.operatorAuthority,
              scopes: ["operator.admin"],
            }),
          },
        ] satisfies Partial<ReplyToolAuthorityOverlay>[]) {
          await expect(
            queueCurrentReplyRunMessage("personal-steering", "different authority", {
              isInboundUserMessage: true,
              toolAuthorityOverlay: { ...toolAuthorityOverlay(incoming), ...changed },
            }),
          ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
        }
        expect(queueMessage).toHaveBeenCalledTimes(2);
      }),
  );

  it("distinguishes session permission and tool settings in steering authority", () => {
    const full = createQueueTestRun({ prompt: "full authority" });
    const guarded = createQueueTestRun({ prompt: "guarded authority" });
    full.run.permissionMode = "full";
    guarded.run.permissionMode = "guarded";
    expect(resolveFollowupRunToolAuthorityFingerprint(full)).not.toBe(
      resolveFollowupRunToolAuthorityFingerprint(guarded),
    );

    guarded.run.permissionMode = "full";
    guarded.run.toolOverrides = { webSearch: false };
    expect(resolveFollowupRunToolAuthorityFingerprint(full)).not.toBe(
      resolveFollowupRunToolAuthorityFingerprint(guarded),
    );
  });

  it.each([
    {
      label: "provider",
      first: { provider: "openai", model: "gpt-test" },
      second: { provider: "anthropic", model: "gpt-test" },
    },
    {
      label: "model",
      first: { provider: "openai", model: "gpt-primary" },
      second: { provider: "openai", model: "gpt-fallback" },
    },
  ])("distinguishes the concrete $label route in steering authority", ({ first, second }) => {
    const run = createQueueTestRun({ prompt: "route authority" });

    expect(resolveFollowupRunToolAuthorityFingerprint(run, first)).not.toBe(
      resolveFollowupRunToolAuthorityFingerprint(run, second),
    );
  });

  it.each(["complete", "fail", "abortByUser", "abortForRestart"] as const)(
    "requires a snapshot for route preparation and rejects it after %s",
    (close) => {
      const run = createQueueTestRun({ prompt: "operation projection" });
      const operation = createTestReplyOperation({ sessionId: "session-projector" });
      const snapshot = prepareReplyToolAuthority(run);
      const overlay = toolAuthorityOverlay(run);
      const route = { provider: "openai", model: "gpt-primary" };

      expect(() => operation.bindToolAuthorityRoute(route)).toThrow(
        "Reply operation has no active tool authority snapshot",
      );
      expect(operation.toolAuthorityRoute).toBeUndefined();
      expect(operation.toolAuthorityFingerprint).toBeUndefined();
      operation.bindToolAuthoritySnapshot(snapshot);
      expect(operation.projectToolAuthorityFingerprint(overlay)).toBeUndefined();

      const fingerprint = resolveFollowupRunToolAuthorityFingerprint(run, route);
      expect(operation.bindToolAuthorityRoute(route)).toBe(fingerprint);
      expect(operation.projectToolAuthorityFingerprint(overlay)).toBe(fingerprint);

      if (close === "fail") {
        operation.fail("run_failed");
      } else {
        operation[close]();
      }
      expect(operation.projectToolAuthorityFingerprint(overlay)).toBeUndefined();
      expect(() => operation.bindToolAuthorityRoute({ ...route, model: "gpt-late" })).toThrow(
        "Reply operation has no active tool authority snapshot",
      );
      expect(operation.toolAuthorityRoute).toEqual(route);
      expect(operation.toolAuthorityFingerprint).toBe(fingerprint);
    },
  );

  it("keeps the initial policy snapshot while tracking concrete fallback authority", () => {
    const run = createQueueTestRun({ prompt: "route authority" });
    const operation = createTestReplyOperation({ sessionId: "session-route" });
    const snapshot = prepareReplyToolAuthority(run);
    const primary = { provider: "openai", model: "gpt-primary" };
    const fallback = { provider: "anthropic", model: "claude-fallback" };
    const primaryFingerprint = resolveFollowupRunToolAuthorityFingerprint(run, primary);
    const fallbackFingerprint = resolveFollowupRunToolAuthorityFingerprint(run, fallback);
    const overlay = toolAuthorityOverlay(run);
    operation.bindToolAuthoritySnapshot(snapshot);

    expect(operation.bindToolAuthorityRoute(primary)).toBe(primaryFingerprint);
    expect(operation.toolAuthorityRoute).toEqual(primary);
    expect(operation.toolAuthorityFingerprint).toBe(primaryFingerprint);

    run.run.execOverrides = { security: "deny" };
    expect(() => operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run))).toThrow(
      "Reply operation cannot change tool authority after admission",
    );
    expect(operation.toolAuthorityFingerprint).toBe(primaryFingerprint);
    expect(operation.bindToolAuthorityRoute(fallback)).toBe(fallbackFingerprint);
    expect(operation.toolAuthorityRoute).toEqual(fallback);
    expect(operation.toolAuthorityFingerprint).toBe(fallbackFingerprint);
    expect(operation.projectToolAuthorityFingerprint(overlay)).toBe(fallbackFingerprint);

    operation.bindToolAuthoritySnapshot(snapshot);
    expect(operation.toolAuthorityRoute).toEqual(fallback);
    expect(operation.toolAuthorityFingerprint).toBe(fallbackFingerprint);
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      toolAuthorityFingerprint: "backend-exact-authority",
    });
    operation.bindToolAuthoritySnapshot(snapshot);
    expect(operation.toolAuthorityRoute).toEqual(fallback);
    expect(operation.toolAuthorityFingerprint).toBe("backend-exact-authority");
    operation.complete();
  });

  it("rejects inbound steering when tool authority changes before backend admission", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createTestReplyOperation({ sessionId: "session-authority" });
    operation.bindToolAuthoritySnapshot({
      fingerprint: () => "authority-a",
      project: () => "authority-a",
    });
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });
    operation.setPhase("running");

    await expect(
      queueCurrentReplyRunMessage("session-authority", "restricted turn", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "authority-b",
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
    expect(queueMessage).not.toHaveBeenCalled();

    await expect(
      queueCurrentReplyRunMessage("session-authority", "same authority", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "authority-a",
      }),
    ).resolves.toEqual({ status: "accepted" });
  });

  it.each(["device-a", "device-b", undefined])(
    "projects inbound authority from reviewer %s without forwarding its approval destination",
    async (approvalReviewerDeviceId) => {
      const run = createQueueTestRun({ prompt: "projected inbound" });
      run.run.approvalReviewerDeviceId = "device-a";
      run.run.gatewayUiCommandTarget = { connId: "browser-a", profileId: "profile-a" };
      run.run.clientCaps = ["ui-commands"];
      run.run.senderIsOwner = true;
      run.run.permissionMode = "full";
      const route = { provider: "openai", model: "gpt-primary" };
      const overlay = { ...toolAuthorityOverlay(run), approvalReviewerDeviceId };
      const queueMessage = vi.fn(
        async (_text: string, _options?: ReplyBackendQueueMessageOptions) => {},
      );
      const operation = createTestReplyOperation({ sessionId: "session-projected-authority" });
      operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
      operation.bindToolAuthorityRoute(route);
      operation.attachBackend({
        kind: "embedded",
        cancel: vi.fn(),
        isStreaming: () => true,
        queueMessage,
      });
      operation.setPhase("running");

      await expect(
        queueCurrentReplyRunMessage("session-projected-authority", "same authority", {
          isInboundUserMessage: true,
          toolAuthorityFingerprint: "caller-cannot-override-projection",
          toolAuthorityOverlay: overlay,
        }),
      ).resolves.toEqual({ status: "accepted" });
      const forwardedOptions = queueMessage.mock.calls[0]?.[1];
      expect(forwardedOptions).toMatchObject({
        isInboundUserMessage: true,
        toolAuthorityFingerprint: resolveFollowupRunToolAuthorityFingerprint(run, route),
      });
      expect(forwardedOptions).not.toHaveProperty("toolAuthorityOverlay");
      expect(forwardedOptions).not.toHaveProperty("approvalReviewerDeviceId");
      expect(queueMessage).toHaveBeenCalledOnce();

      for (const restricted of [
        { clientCaps: ["changed-capability"] },
        { gatewayUiCommandTarget: { connId: "browser-b", profileId: "profile-a" } },
        { gatewayUiCommandTarget: { connId: "browser-a", profileId: "profile-b" } },
        { gatewayUiCommandTarget: undefined },
        { toolBindings: { browser: { clientId: "different-browser" } } },
        { permissionMode: "guarded" },
      ] satisfies Partial<ReplyToolAuthorityOverlay>[]) {
        await expect(
          queueCurrentReplyRunMessage("session-projected-authority", "changed authority", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: { ...overlay, ...restricted },
          }),
        ).resolves.toMatchObject({ status: "rejected", reason: "tool_authority_mismatch" });
        expect(queueMessage).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    { restriction: "disabled", themeAvailable: false },
    { restriction: "no-capability", themeAvailable: true },
    { restriction: "runtime-cap", themeAvailable: false },
    { restriction: "runtime-theme", themeAvailable: true },
    { restriction: "runtime-intersection", themeAvailable: false },
    { restriction: "policy-deny", themeAvailable: true },
    { restriction: "policy-theme-deny", themeAvailable: false },
    { restriction: "profile", themeAvailable: false },
    { restriction: "non-owner", themeAvailable: true },
  ])(
    "preserves steering within available theme authority when screen is unavailable: $restriction",
    async ({ restriction, themeAvailable }) => {
      const run = createQueueTestRun({ prompt: "cross-browser steering" });
      run.run.gatewayUiCommandTarget = { connId: "browser-a", profileId: "profile-a" };
      run.run.clientCaps = ["ui-commands"];
      run.run.senderIsOwner = restriction !== "non-owner";
      if (restriction === "disabled") {
        run.disableTools = true;
      }
      if (restriction === "no-capability") {
        run.run.clientCaps = [];
      }
      if (restriction === "runtime-cap") {
        run.toolsAllow = ["read"];
      }
      if (restriction === "runtime-theme") {
        run.toolsAllow = ["read", "theme"];
      }
      if (restriction === "runtime-intersection") {
        run.toolsAllow = attachToolAllowlistIntersection(
          ["read", "screen"],
          [["read", "screen"], ["read"]],
        );
      }
      if (restriction === "policy-deny") {
        run.run.config = { tools: { deny: ["screen"] } };
      }
      if (restriction === "policy-theme-deny") {
        run.run.config = { tools: { deny: ["screen", "theme"] } };
      }
      if (restriction === "profile") {
        run.run.config = { tools: { profile: "minimal" } };
      }
      const queueMessage = vi.fn(async () => {});
      const operation = createTestReplyOperation({ sessionId: "screen-unavailable" });
      operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run));
      operation.bindToolAuthorityRoute({ provider: run.run.provider, model: run.run.model });
      operation.attachBackend({
        kind: "embedded",
        cancel: vi.fn(),
        isStreaming: () => true,
        queueMessage,
      });
      operation.setPhase("running");

      await expect(
        queueCurrentReplyRunMessage("screen-unavailable", "steer from another browser", {
          isInboundUserMessage: true,
          toolAuthorityOverlay: {
            ...toolAuthorityOverlay(run),
            gatewayUiCommandTarget: { connId: "browser-b", profileId: "profile-a" },
          },
        }),
      ).resolves.toEqual({ status: "accepted" });
      expect(queueMessage).toHaveBeenCalledOnce();

      for (const gatewayUiCommandTarget of [
        { connId: "browser-b", profileId: "profile-b" },
        { connId: "browser-b" },
        undefined,
      ]) {
        await expect(
          queueCurrentReplyRunMessage("screen-unavailable", "steer with another profile", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: { ...toolAuthorityOverlay(run), gatewayUiCommandTarget },
          }),
        ).resolves.toEqual(
          themeAvailable
            ? { status: "rejected", reason: "tool_authority_mismatch" }
            : { status: "accepted" },
        );
      }
      expect(queueMessage).toHaveBeenCalledTimes(themeAvailable ? 1 : 4);
    },
  );
});
