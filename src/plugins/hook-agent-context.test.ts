/** Verifies hook callbacks receive agent context and scoped plugin metadata. */
import { describe, expect, it } from "vitest";
import { registerCronRunExecSource } from "../infra/cron-run-exec-source.js";
import {
  buildAgentHookContextCronFields,
  buildAgentHookContextChannelFields,
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

describe("buildAgentHookContextCronFields", () => {
  it("uses the executing snapshot rather than a job edited while the run is active", () => {
    const job = { id: "daily-check", configRevision: "revision-start" };
    const unregister = registerCronRunExecSource("cron-hook-run", {
      agentId: "main",
      jobId: job.id,
      jobConfigRevision: job.configRevision,
      jobName: "Daily check",
    });
    try {
      job.configRevision = "revision-edited";
      const context = buildAgentHookContextCronFields({
        runId: "cron-hook-run",
        agentId: "main",
        trigger: "cron",
      });
      expect(context).toEqual({ jobId: "daily-check", jobConfigRevision: "revision-start" });
      unregister();
      expect(
        buildAgentHookContextCronFields({
          runId: "cron-hook-run",
          agentId: "main",
          trigger: "cron",
        }),
      ).toEqual({});
      expect(context.jobConfigRevision).toBe("revision-start");
    } finally {
      unregister();
    }
  });

  it("does not infer cron provenance from caller-supplied job ids or another agent's run", () => {
    const unregister = registerCronRunExecSource("cron-hook-sibling", {
      agentId: "main",
      jobId: "daily-check",
      jobConfigRevision: "revision-start",
      jobName: "Daily check",
    });
    try {
      for (const context of [
        { runId: "cron-hook-sibling", agentId: "other", trigger: "cron" },
        { runId: "cron-hook-sibling", agentId: "main", trigger: "user" },
        { runId: "not-registered", agentId: "main", trigger: "cron", jobId: "daily-check" },
        { agentId: "main", trigger: "cron", jobId: "daily-check" },
      ]) {
        expect(buildAgentHookContextCronFields(context)).toEqual({});
      }
    } finally {
      unregister();
    }
  });
});
