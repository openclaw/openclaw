import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "agent-123",
}));

import { createCronTool } from "./cron-tool.js";

describe("cron tool", () => {
  function readGatewayCall(index = 0): { method?: string; params?: Record<string, unknown> } {
    return (
      (callGatewayMock.mock.calls[index]?.[0] as
        | { method?: string; params?: Record<string, unknown> }
        | undefined) ?? { method: undefined, params: undefined }
    );
  }

  function readCronPayloadText(index = 0): string {
    const params = readGatewayCall(index).params as { payload?: { text?: string } } | undefined;
    return params?.payload?.text ?? "";
  }

  async function executeAddAndReadDelivery(params: {
    callId: string;
    agentSessionKey: string;
    delivery?: { mode?: string; channel?: string; to?: string } | null;
  }) {
    const tool = createCronTool({ agentSessionKey: params.agentSessionKey });
    await tool.execute(params.callId, {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "agentTurn", message: "hello" },
        ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { delivery?: { mode?: string; channel?: string; to?: string } };
    };
    return call?.params?.delivery;
  }

  async function executeAddAndReadSessionKey(params: {
    callId: string;
    agentSessionKey: string;
    jobSessionKey?: string;
  }): Promise<string | undefined> {
    const tool = createCronTool({ agentSessionKey: params.agentSessionKey });
    await tool.execute(params.callId, {
      action: "add",
      job: {
        name: "wake-up",
        schedule: { at: new Date(123).toISOString() },
        ...(params.jobSessionKey ? { sessionKey: params.jobSessionKey } : {}),
        payload: { kind: "systemEvent", text: "hello" },
      },
    });
    const call = readGatewayCall();
    const payload = call.params as { sessionKey?: string } | undefined;
    return payload?.sessionKey;
  }

  async function executeAddWithContextMessages(callId: string, contextMessages: number) {
    const tool = createCronTool({ agentSessionKey: "main" });
    await tool.execute(callId, {
      action: "add",
      contextMessages,
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "systemEvent", text: "Reminder: the thing." },
      },
    });
  }

  beforeEach(() => {
    callGatewayMock.mockClear();
    callGatewayMock.mockResolvedValue({ ok: true });
  });

  it("marks cron as owner-only", async () => {
    const tool = createCronTool();
    expect(tool.ownerOnly).toBe(true);
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

  it("stamps cron.add with caller sessionKey when missing", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const callerSessionKey = "agent:main:discord:channel:ops";
    const sessionKey = await executeAddAndReadSessionKey({
      callId: "call-session-key",
      agentSessionKey: callerSessionKey,
    });
    expect(sessionKey).toBe(callerSessionKey);
  });

  it("preserves explicit job.sessionKey on add", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const sessionKey = await executeAddAndReadSessionKey({
      callId: "call-explicit-session-key",
      agentSessionKey: "agent:main:discord:channel:ops",
      jobSessionKey: "agent:main:telegram:group:-100123:topic:99",
    });
    expect(sessionKey).toBe("agent:main:telegram:group:-100123:topic:99");
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

    await executeAddWithContextMessages("call3", 3);

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    const historyCall = readGatewayCall(0);
    expect(historyCall.method).toBe("chat.history");

    const cronCall = readGatewayCall(1);
    expect(cronCall.method).toBe("cron.add");
    const text = readCronPayloadText(1);
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

    await executeAddWithContextMessages("call5", 20);

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    const historyCall = readGatewayCall(0);
    expect(historyCall.method).toBe("chat.history");
    const historyParams = historyCall.params as { limit?: number } | undefined;
    expect(historyParams?.limit).toBe(10);

    const text = readCronPayloadText(1);
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
    const cronCall = readGatewayCall(0);
    expect(cronCall.method).toBe("cron.add");
    const text = readCronPayloadText(0);
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
    expect(
      await executeAddAndReadDelivery({
        callId: "call-thread",
        agentSessionKey: "agent:main:slack:channel:general:thread:1699999999.0001",
      }),
    ).toEqual({
      mode: "announce",
      channel: "slack",
      to: "general",
    });
  });

  it("preserves telegram forum topics when inferring delivery", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-telegram-topic",
        agentSessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890:topic:99",
    });
  });

  it("infers delivery when delivery is null", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-null-delivery",
        agentSessionKey: "agent:main:dm:alice",
        delivery: null,
      }),
    ).toEqual({
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
    const delivery = await executeAddAndReadDelivery({
      callId: "call-none",
      agentSessionKey: "agent:main:discord:dm:buddy",
      delivery: { mode: "none" },
    });
    expect(delivery).toEqual({ mode: "none" });
  });

  it("does not infer announce delivery when mode is webhook", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });
    const delivery = await executeAddAndReadDelivery({
      callId: "call-webhook-explicit",
      agentSessionKey: "agent:main:discord:dm:buddy",
      delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
    });
    expect(delivery).toEqual({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
  });

  it("fails fast when webhook mode is missing delivery.to", async () => {
    const tool = createCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });

    await expect(
      tool.execute("call-webhook-missing", {
        action: "add",
        job: {
          name: "reminder",
          schedule: { at: new Date(123).toISOString() },
          payload: { kind: "agentTurn", message: "hello" },
          delivery: { mode: "webhook" },
        },
      }),
    ).rejects.toThrow('delivery.mode="webhook" requires delivery.to to be a valid http(s) URL');
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("fails fast when webhook mode uses a non-http URL", async () => {
    const tool = createCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });

    await expect(
      tool.execute("call-webhook-invalid", {
        action: "add",
        job: {
          name: "reminder",
          schedule: { at: new Date(123).toISOString() },
          payload: { kind: "agentTurn", message: "hello" },
          delivery: { mode: "webhook", to: "ftp://example.invalid/cron-finished" },
        },
      }),
    ).rejects.toThrow('delivery.mode="webhook" requires delivery.to to be a valid http(s) URL');
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });
});
