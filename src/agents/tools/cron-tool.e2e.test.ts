import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "agent-123",
}));

import { createCronTool } from "./cron-tool.js";

describe("cron tool", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({ ok: true });
  });

  it.each([
    [
      "update",
      { action: "update", jobId: "job-1", patch: { foo: "bar" } },
      { id: "job-1", patch: { foo: "bar" } },
    ],
    [
      "update",
      { action: "update", id: "job-2", patch: { foo: "bar" } },
      { id: "job-2", patch: { foo: "bar" } },
    ],
    ["remove", { action: "remove", jobId: "job-1" }, { id: "job-1" }],
    ["remove", { action: "remove", id: "job-2" }, { id: "job-2" }],
    ["run", { action: "run", jobId: "job-1" }, { id: "job-1", mode: "force" }],
    ["run", { action: "run", id: "job-2" }, { id: "job-2", mode: "force" }],
    ["runs", { action: "runs", jobId: "job-1" }, { id: "job-1" }],
    ["runs", { action: "runs", id: "job-2" }, { id: "job-2" }],
  ])("%s sends id to gateway", async (action, args, expectedParams) => {
    const tool = createCronTool();
    await tool.execute("call1", args);

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: unknown;
    };
    expect(call.method).toBe(`cron.${action}`);
    expect(call.params).toEqual(expectedParams);
  });

  it("prefers jobId over id when both are provided", async () => {
    const tool = createCronTool();
    await tool.execute("call1", {
      action: "run",
      jobId: "job-primary",
      id: "job-legacy",
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: unknown;
    };
    expect(call?.params).toEqual({ id: "job-primary", mode: "force" });
  });

  it("supports due-only run mode", async () => {
    const tool = createCronTool();
    await tool.execute("call-due", {
      action: "run",
      jobId: "job-due",
      runMode: "due",
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: unknown;
    };
    expect(call?.params).toEqual({ id: "job-due", mode: "due" });
  });

  it("normalizes cron.add job payloads", async () => {
    const tool = createCronTool();
    await tool.execute("call2", {
      action: "add",
      job: {
        data: {
          name: "wake-up",
          schedule: { atMs: 123 },
          payload: { kind: "systemEvent", text: "hello" },
        },
      },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: unknown;
    };
    expect(call.method).toBe("cron.add");
    expect(call.params).toEqual({
      name: "wake-up",
      enabled: true,
      deleteAfterRun: true,
      schedule: { kind: "at", at: new Date(123).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });
  });

  it("does not default agentId when job.agentId is null", async () => {
    const tool = createCronTool({ agentSessionKey: "main" });
    await tool.execute("call-null", {
      action: "add",
      job: {
        name: "wake-up",
        schedule: { at: new Date(123).toISOString() },
        agentId: null,
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { agentId?: unknown };
    };
    expect(call?.params?.agentId).toBeNull();
  });

  it("adds recent context for systemEvent reminders when contextMessages > 0", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        messages: [
          { role: "user", content: [{ type: "text", text: "Discussed Q2 budget" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "We agreed to review on Tuesday." }],
          },
          { role: "user", content: [{ type: "text", text: "Remind me about the thing at 2pm" }] },
        ],
      })
      .mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "main" });
    await tool.execute("call3", {
      action: "add",
      contextMessages: 3,
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "systemEvent", text: "Reminder: the thing." },
      },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    const historyCall = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: unknown;
    };
    expect(historyCall.method).toBe("chat.history");

    const cronCall = callGatewayMock.mock.calls[1]?.[0] as {
      method?: string;
      params?: { payload?: { text?: string } };
    };
    expect(cronCall.method).toBe("cron.add");
    const text = cronCall.params?.payload?.text ?? "";
    expect(text).toContain("Recent context:");
    expect(text).toContain("User: Discussed Q2 budget");
    expect(text).toContain("Assistant: We agreed to review on Tuesday.");
    expect(text).toContain("User: Remind me about the thing at 2pm");
  });

  it("caps contextMessages at 10", async () => {
    const messages = Array.from({ length: 12 }, (_, idx) => ({
      role: "user",
      content: [{ type: "text", text: `Message ${idx + 1}` }],
    }));
    callGatewayMock.mockResolvedValueOnce({ messages }).mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "main" });
    await tool.execute("call5", {
      action: "add",
      contextMessages: 20,
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "systemEvent", text: "Reminder: the thing." },
      },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    const historyCall = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: { limit?: number };
    };
    expect(historyCall.method).toBe("chat.history");
    expect(historyCall.params?.limit).toBe(10);

    const cronCall = callGatewayMock.mock.calls[1]?.[0] as {
      params?: { payload?: { text?: string } };
    };
    const text = cronCall.params?.payload?.text ?? "";
    expect(text).not.toMatch(/Message 1\\b/);
    expect(text).not.toMatch(/Message 2\\b/);
    expect(text).toContain("Message 3");
    expect(text).toContain("Message 12");
  });

  it("does not add context when contextMessages is 0 (default)", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "main" });
    await tool.execute("call4", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { text: "Reminder: the thing." },
      },
    });

    // Should only call cron.add, not chat.history
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const cronCall = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: { payload?: { text?: string } };
    };
    expect(cronCall.method).toBe("cron.add");
    const text = cronCall.params?.payload?.text ?? "";
    expect(text).not.toContain("Recent context:");
  });

  it("preserves explicit agentId null on add", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "main" });
    await tool.execute("call6", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        agentId: null,
        payload: { kind: "systemEvent", text: "Reminder: the thing." },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: { agentId?: string | null };
    };
    expect(call.method).toBe("cron.add");
    expect(call.params?.agentId).toBeNull();
  });

  it("infers delivery from threaded session keys", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({
      agentSessionKey: "agent:main:slack:channel:general:thread:1699999999.0001",
    });
    await tool.execute("call-thread", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "agentTurn", message: "hello" },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { delivery?: { mode?: string; channel?: string; to?: string } };
    };
    expect(call?.params?.delivery).toEqual({
      mode: "announce",
      channel: "slack",
      to: "general",
    });
  });

  it("preserves telegram forum topics when inferring delivery", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({
      agentSessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
    });
    await tool.execute("call-telegram-topic", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "agentTurn", message: "hello" },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { delivery?: { mode?: string; channel?: string; to?: string } };
    };
    expect(call?.params?.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890:topic:99",
    });
  });

  it("infers delivery when delivery is null", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "agent:main:dm:alice" });
    await tool.execute("call-null-delivery", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "agentTurn", message: "hello" },
        delivery: null,
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { delivery?: { mode?: string; channel?: string; to?: string } };
    };
    expect(call?.params?.delivery).toEqual({
      mode: "announce",
      to: "alice",
    });
  });

  // ── Flat-params recovery (issue #11310) ──────────────────────────────

  it("recovers flat params when job is missing", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-flat", {
      action: "add",
      name: "flat-job",
      schedule: { kind: "at", at: new Date(123).toISOString() },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "do stuff" },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: { name?: string; sessionTarget?: string; payload?: { kind?: string } };
    };
    expect(call.method).toBe("cron.add");
    expect(call.params?.name).toBe("flat-job");
    expect(call.params?.sessionTarget).toBe("isolated");
    expect(call.params?.payload?.kind).toBe("agentTurn");
  });

  it("recovers flat params when job is empty object", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-empty-job", {
      action: "add",
      job: {},
      name: "empty-job",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "wake up" },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: { name?: string; sessionTarget?: string; payload?: { text?: string } };
    };
    expect(call.method).toBe("cron.add");
    expect(call.params?.name).toBe("empty-job");
    expect(call.params?.sessionTarget).toBe("main");
    expect(call.params?.payload?.text).toBe("wake up");
  });

  it("recovers flat message shorthand as agentTurn payload", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-msg-shorthand", {
      action: "add",
      schedule: { kind: "at", at: new Date(456).toISOString() },
      message: "do stuff",
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: { payload?: { kind?: string; message?: string }; sessionTarget?: string };
    };
    expect(call.method).toBe("cron.add");
    // normalizeCronJobCreate infers agentTurn from message and isolated from agentTurn
    expect(call.params?.payload?.kind).toBe("agentTurn");
    expect(call.params?.payload?.message).toBe("do stuff");
    expect(call.params?.sessionTarget).toBe("isolated");
  });

  it("does not recover flat params when no meaningful job field is present", async () => {
    const tool = createCronTool();
    await expect(
      tool.execute("call-no-signal", {
        action: "add",
        name: "orphan-name",
        enabled: true,
      }),
    ).rejects.toThrow("job required");
  });

  it("prefers existing non-empty job over flat params", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-nested-wins", {
      action: "add",
      job: {
        name: "nested-job",
        schedule: { kind: "at", at: new Date(123).toISOString() },
        payload: { kind: "systemEvent", text: "from nested" },
      },
      name: "flat-name-should-be-ignored",
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { name?: string; payload?: { text?: string } };
    };
    expect(call?.params?.name).toBe("nested-job");
    expect(call?.params?.payload?.text).toBe("from nested");
  });

  it("does not infer delivery when mode is none", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });
    await tool.execute("call-none", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "agentTurn", message: "hello" },
        delivery: { mode: "none" },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { delivery?: { mode?: string; channel?: string; to?: string } };
    };
    expect(call?.params?.delivery).toEqual({ mode: "none" });
  });
});
