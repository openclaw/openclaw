import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createTestReplyOperation,
  queueCurrentReplyRunMessage,
} from "./reply-run-registry.test-helpers.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createQueueTestRun, toolAuthorityOverlay } from "./reply-tool-authority.test-support.js";

describe("reply requester authority", () => {
  afterEach(() => {
    testing.resetSessionControllerForTest();
  });

  it.each<{
    name: string;
    senderId: string | undefined;
    accountId?: string;
    senderName?: string;
    unknownOwner?: boolean;
    collaborative?: true;
    conversationId?: string | null;
    threadId?: string;
    accepted: boolean;
  }>([
    { name: "same channel requester", senderId: "alice", accepted: true },
    {
      name: "same requester with changed permissions while collaboration is enabled",
      senderId: "alice",
      collaborative: true,
      accepted: false,
    },
    { name: "another channel requester with equal permissions", senderId: "bob", accepted: false },
    {
      name: "collaborator with fewer permissions",
      senderId: "bob",
      collaborative: true,
      accepted: true,
    },
    {
      name: "collaborator in another conversation",
      senderId: "bob",
      collaborative: true,
      conversationId: "other-room",
      accepted: false,
    },
    {
      name: "collaborator without conversation facts",
      senderId: "bob",
      collaborative: true,
      conversationId: null,
      accepted: false,
    },
    {
      name: "collaborator in another thread",
      senderId: "bob",
      collaborative: true,
      threadId: "other-thread",
      accepted: false,
    },
    {
      name: "collaborator on another account",
      senderId: "bob",
      collaborative: true,
      accountId: "other",
      accepted: false,
    },
    {
      name: "unidentified collaborator",
      senderId: undefined,
      collaborative: true,
      accepted: false,
    },
    {
      name: "same sender on another account",
      senderId: "alice",
      accountId: "other",
      accepted: false,
    },
    { name: "display-name drift", senderId: "alice", senderName: "Alice renamed", accepted: true },
    { name: "unidentified input", senderId: undefined, accepted: false },
    {
      name: "unidentified owner and input",
      senderId: undefined,
      unknownOwner: true,
      accepted: false,
    },
  ])(
    "preserves requester identity for $name",
    async ({
      senderId,
      accountId,
      senderName,
      unknownOwner,
      collaborative,
      conversationId,
      threadId,
      accepted,
    }) => {
      const run = createQueueTestRun({ prompt: "Alice's work" });
      run.run.conversationId = "shared-room";
      if (unknownOwner) {
        delete run.run.senderId;
      }
      const operation = createTestReplyOperation({ sessionId: "requester-identity" });
      const snapshot = prepareReplyToolAuthority(run);
      await operation.bindToolAuthoritySnapshotAsync(snapshot);
      await operation.bindToolAuthorityRouteAsync(run.run);
      const queueMessage = vi.fn(async () => {});
      const cancel = vi.fn();
      operation.attachBackend({ kind: "embedded", cancel, queueMessage });
      operation.setPhase("running");
      const incoming = {
        ...run,
        ...(collaborative ? { toolsAllow: ["read"] } : {}),
        run: {
          ...run.run,
          senderId,
          senderName,
          agentAccountId: accountId,
          conversationId: conversationId === null ? undefined : (conversationId ?? "shared-room"),
          messageThreadId: threadId,
        },
      };
      const outcome = await queueCurrentReplyRunMessage("requester-identity", "change the work", {
        isInboundUserMessage: true,
        toolAuthorityOverlay: toolAuthorityOverlay(incoming),
        allowCollaborativeSteering: collaborative,
      });
      expect(outcome).toMatchObject(
        accepted
          ? { status: "accepted" }
          : { status: "rejected", reason: "tool_authority_mismatch" },
      );
      expect(queueMessage).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(cancel).not.toHaveBeenCalled();
      expect(snapshot.fingerprint()).toBe(operation.toolAuthorityFingerprint);
    },
  );

  it.each(["scheduled", "legacy-conversation"] as const)(
    "evaluates a fresh request without the incumbent's %s shortcut",
    async (shortcut) => {
      const plugin: ChannelPlugin = {
        ...createChannelTestPluginBase({ id: "telegram" }),
        groups: {
          resolveToolPolicy: ({ cfg, groupId }) =>
            groupId ? cfg.channels?.telegram?.groups?.[groupId]?.tools : undefined,
        },
      };
      await withPluginRuntimeRegistryScope(
        createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]),
        async () => {
          const run = createQueueTestRun({ prompt: "admitted work" });
          if (shortcut === "scheduled") {
            run.run.scheduledToolPolicy = { version: 1, mode: "trusted" };
          } else {
            run.run.conversationToolPolicy = { deny: ["write"] };
          }
          const requesterOrigin = {
            sessionKey: "agent:agent:telegram:group:requester-group",
            messageProvider: "telegram",
            groupId: "requester-group",
            senderId: "alice",
          };
          const deniedConfig: OpenClawConfig =
            shortcut === "scheduled"
              ? { tools: { toolsBySender: { "id:alice": { deny: ["exec"] } } } }
              : {
                  channels: {
                    telegram: { groups: { "requester-group": { tools: { deny: ["exec"] } } } },
                  },
                };
          const snapshot = prepareReplyToolAuthority(run);
          try {
            const original = await snapshot.fingerprintAsync(run.run);
            const allowed = await snapshot.projectRequesterAsync(
              { requesterOrigin, config: {} },
              run.run,
            );
            const denied = await snapshot.projectRequesterAsync(
              { requesterOrigin, config: deniedConfig },
              run.run,
            );
            expect(denied).not.toBe(allowed);
            expect(snapshot.fingerprint(run.run)).toBe(original);
          } finally {
            snapshot.close();
          }
        },
      );
    },
  );

  it("uses the new human requester when steering an origin-bearing continuation", async () => {
    const run = createQueueTestRun({ prompt: "accepted continuation" });
    run.run.sessionKey = "agent:agent:main";
    run.run.config = {
      tools: {
        toolsBySender: {
          "id:permitted": { allow: ["read", "message"] },
          "*": { allow: ["read"] },
        },
      },
    };
    const continuation = {
      ...run,
      run: {
        ...run.run,
        requesterOrigin: {
          sessionKey: "agent:agent:telegram:direct:requester",
          messageProvider: "telegram",
          senderId: "permitted",
        },
      },
    };
    const operation = createTestReplyOperation({ sessionId: "continuation-human-steering" });
    await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(continuation));
    await operation.bindToolAuthorityRouteAsync(run.run);
    const queueMessage = vi.fn(async () => {});
    operation.attachBackend({ kind: "embedded", cancel: vi.fn(), queueMessage });
    operation.setPhase("running");
    const inject = (senderId: string) =>
      queueCurrentReplyRunMessage("continuation-human-steering", "new human instruction", {
        isInboundUserMessage: true,
        toolAuthorityOverlay: {
          ...toolAuthorityOverlay(run),
          messageProvider: "telegram",
          senderId,
        },
      });
    await expect(inject("permitted")).resolves.toEqual({ status: "accepted" });
    await expect(inject("guest")).resolves.toMatchObject({
      status: "rejected",
      reason: "tool_authority_mismatch",
    });
    expect(queueMessage).toHaveBeenCalledOnce();
  });
});
