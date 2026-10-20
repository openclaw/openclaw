import { afterEach, expect, it, vi } from "vitest";
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

type RequesterOptions = {
  accountId?: string;
  senderName?: string;
  unknownOwner?: boolean;
  collaborative?: true;
  conversationId?: string | null;
  threadId?: string;
};

async function admit(run: ReturnType<typeof createQueueTestRun>, sessionId: string) {
  const operation = createTestReplyOperation({ sessionId });
  const snapshot = prepareReplyToolAuthority(run);
  await operation.bindToolAuthoritySnapshotAsync(snapshot);
  await operation.bindToolAuthorityRouteAsync(run.run);
  const queueMessage = vi.fn(async () => {});
  const cancel = vi.fn();
  operation.attachBackend({ kind: "embedded", cancel, queueMessage });
  operation.setPhase("running");
  return { operation, snapshot, queueMessage, cancel };
}

afterEach(() => {
  testing.resetSessionControllerForTest();
});

it.each<[string, string | undefined, boolean, RequesterOptions?]>([
  ["same requester", "alice", true],
  ["changed permissions", "alice", false, { collaborative: true }],
  ["other requester", "bob", false],
  ["restricted collaborator", "bob", true, { collaborative: true }],
  ["other room", "bob", false, { collaborative: true, conversationId: "other-room" }],
  ["missing room", "bob", false, { collaborative: true, conversationId: null }],
  ["other thread", "bob", false, { collaborative: true, threadId: "other-thread" }],
  ["other account", "bob", false, { collaborative: true, accountId: "other" }],
  ["unidentified collaborator", undefined, false, { collaborative: true }],
  ["same sender, other account", "alice", false, { accountId: "other" }],
  ["display-name drift", "alice", true, { senderName: "Alice renamed" }],
  ["unidentified input", undefined, false],
  ["unidentified owner and input", undefined, false, { unknownOwner: true }],
])(
  "preserves requester identity: %s",
  async (
    _name,
    senderId,
    accepted,
    { accountId, senderName, unknownOwner, collaborative, conversationId, threadId } = {},
  ) => {
    const run = createQueueTestRun({ prompt: "Alice's work" });
    run.run.conversationId = "shared-room";
    if (unknownOwner) {
      delete run.run.senderId;
    }
    const { operation, snapshot, queueMessage, cancel } = await admit(run, "requester-identity");
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
      accepted ? { status: "accepted" } : { status: "rejected", reason: "tool_authority_mismatch" },
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
  const toolsBySender = {
    "id:permitted": { allow: ["read", "message"] },
    "*": { allow: ["read"] },
  };
  run.run.config = { tools: { toolsBySender } };
  const requesterOrigin = {
    sessionKey: "agent:agent:telegram:direct:requester",
    messageProvider: "telegram",
    senderId: "permitted",
  };
  const continuation = { ...run, run: { ...run.run, requesterOrigin } };
  const { queueMessage } = await admit(continuation, "continuation-human-steering");
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
