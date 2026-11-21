/** Verifies hook callbacks receive agent context and scoped plugin metadata. */
import { describe, expect, it } from "vitest";
import {
  captureExecRequestOwners,
  type ExecRequestOwner,
  withExecRequestTurn,
} from "../infra/exec-request-context.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextExecRequestFields,
  buildAgentHookContextIdentityFields,
} from "./hook-agent-context.js";

describe("buildAgentHookContextChannelFields", () => {
  it("keeps provider and conversation id separate", () => {
    expect(
      buildAgentHookContextChannelFields({
        sessionKey: "agent:main:discord:channel:c1",
        messageChannel: "discord",
        messageProvider: "discord",
        agentAccountId: "work",
        senderId: "user-123",
      }),
    ).toEqual({
      channel: "discord",
      accountId: "work",
      messageProvider: "discord",
      channelId: "c1",
      chatId: "c1",
      senderId: "user-123",
    });
  });

  it("uses the provider as channel when message channel is a target id", () => {
    expect(
      buildAgentHookContextChannelFields({
        messageChannel: "channel:1472750640760623226",
        messageProvider: "discord",
      }),
    ).toEqual({
      channel: "discord",
      messageProvider: "discord",
      channelId: "1472750640760623226",
      chatId: "1472750640760623226",
      senderId: undefined,
    });
  });
});

describe("buildAgentHookContextIdentityFields", () => {
  it("mirrors flat sender and chat ids into channel-owned context", () => {
    expect(
      buildAgentHookContextIdentityFields({
        senderId: "open-id-1",
        chatId: "chat-1",
      }),
    ).toEqual({
      senderId: "open-id-1",
      chatId: "chat-1",
      channelContext: {
        sender: { id: "open-id-1" },
        chat: { id: "chat-1" },
      },
    });
  });

  it("preserves plugin-augmented channel fields while keeping id compatible", () => {
    expect(
      buildAgentHookContextIdentityFields({
        senderId: "open-id-1",
        channelContext: {
          sender: { id: "stale-id", userId: "user-1" } as { id?: string; userId: string },
        },
      }),
    ).toEqual({
      senderId: "open-id-1",
      channelContext: {
        sender: { id: "open-id-1", userId: "user-1" },
      },
    });
  });

  it("exposes the verified requester device for user turns only", () => {
    expect(
      buildAgentHookContextIdentityFields({
        trigger: "user",
        approvalReviewerDeviceId: " device-1 ",
      }),
    ).toEqual({ requesterDeviceId: "device-1" });
    expect(buildAgentHookContextIdentityFields({ approvalReviewerDeviceId: "device-1" })).toEqual({
      requesterDeviceId: "device-1",
    });
    expect(
      buildAgentHookContextIdentityFields({ trigger: "user", senderId: "openclaw-ios" }),
    ).not.toHaveProperty("requesterDeviceId");
    expect(
      buildAgentHookContextIdentityFields({
        trigger: "cron",
        approvalReviewerDeviceId: "device-1",
      }),
    ).toEqual({});
  });

  it("omits identity fields for system-originated triggers", () => {
    expect(
      buildAgentHookContextIdentityFields({
        trigger: "cron",
        senderId: "open-id-1",
        chatId: "chat-1",
      }),
    ).toEqual({});
  });
});

describe("exec request owners on agent hook contexts", () => {
  const identity = (trigger: string) => buildAgentHookContextIdentityFields({ trigger });
  const start = (runId: string, ownerDeviceId?: string) =>
    withExecRequestTurn(
      {
        identity: {
          runId,
          sessionKey: "agent:main:main",
          sessionId: "session-1",
          ...(ownerDeviceId ? { ownerDeviceId } : {}),
        },
      },
      async () => {
        const owners = captureExecRequestOwners({ runId, sessionId: "session-1" }) ?? [];
        // A run re-entering with its own captured owners (for example a tool callback) continues nothing.
        const reentered = await withExecRequestTurn(
          { identity: { runId, sessionId: "session-2" }, owners },
          async () => identity("user"),
        );
        return { owners, own: identity("user"), reentered };
      },
    );
  const complete = (runId: string, owners: readonly ExecRequestOwner[]) =>
    withExecRequestTurn(
      {
        identity: { runId, sessionKey: "agent:main:main", sessionId: "session-1" },
        owners,
        continues: true,
      },
      async () => identity("event"),
    );

  it("names the starting turn on an idle session's completion run", async () => {
    const a = await start("run-a", "device-a");
    expect(a.own).not.toHaveProperty("execRequestOwners");
    expect(a.reentered).not.toHaveProperty("execRequestOwners");
    const fields = await complete("run-completion", a.owners);
    expect(fields).toEqual({
      execRequestOwners: [
        {
          runId: "run-a",
          sessionKey: "agent:main:main",
          sessionId: "session-1",
          ownerDeviceId: "device-a",
        },
      ],
    });
    expect(Object.isFrozen(fields.execRequestOwners)).toBe(true);
    expect(Object.isFrozen(fields.execRequestOwners?.[0])).toBe(true);
    // The completion is recorded as a continuation alias; the original run stays the owner.
    expect(a.owners[0]?.turnRunIds.has("run-completion")).toBe(true);
  });

  it("lists every starter when one completion drains overlapping execs", async () => {
    const a = await start("run-a", "device-a");
    const b = await start("run-b");
    const fields = await complete("run-completion", [...a.owners, ...b.owners]);
    expect(fields.execRequestOwners?.map((owner) => owner.runId)).toEqual(["run-a", "run-b"]);
    expect(fields.execRequestOwners?.[1]).not.toHaveProperty("ownerDeviceId");
  });

  it("names the starter, not the running turn, when the completion drains inside a busy turn", async () => {
    const a = await start("run-a", "device-a");
    const seen = await withExecRequestTurn(
      { identity: { runId: "run-busy", sessionKey: "agent:main:main", sessionId: "session-1" } },
      async () => {
        const before = identity("user");
        const completion = await complete("run-completion", a.owners);
        return {
          before,
          completion,
          after: identity("user"),
        };
      },
    );
    expect(seen.before).not.toHaveProperty("execRequestOwners");
    expect(seen.after).not.toHaveProperty("execRequestOwners");
    expect(seen.completion.execRequestOwners?.map((owner) => owner.runId)).toEqual(["run-a"]);
  });

  it("gives before_tool_call the same owners as the agent hooks", async () => {
    const a = await start("run-a", "device-a");
    const fields = await withExecRequestTurn(
      {
        identity: { runId: "run-completion", sessionId: "session-1" },
        owners: a.owners,
        continues: true,
      },
      async () => ({
        agent: identity("event"),
        tool: buildAgentHookContextExecRequestFields(),
      }),
    );
    expect(fields.agent.execRequestOwners?.map((owner) => owner.runId)).toEqual(["run-a"]);
    expect(fields.tool).toEqual({ execRequestOwners: fields.agent.execRequestOwners });
  });

  it("is absent outside a run", async () => {
    expect(identity("event")).toEqual({});
    expect(buildAgentHookContextExecRequestFields()).toEqual({});
  });
});
