import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentId: () => "agent-123",
}));

import {
  validateCronAddParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronStatusParams,
  validateCronUpdateParams,
  validateWakeParams,
} from "../../gateway/protocol/index.js";
import { createCronTool } from "./cron-tool.js";

describe("cron tool", () => {
  function readGatewayCall(index = 0) {
    return callGatewayMock.mock.calls[index]?.[0] as {
      method?: string;
      params?: unknown;
    };
  }

  function assertValid(
    validator: { (data: unknown): boolean; errors?: Array<{ message?: string }> | null },
    data: unknown,
  ) {
    const ok = validator(data);
    if (!ok) {
      const message = (validator.errors ?? [])
        .map((entry) => entry?.message ?? "unknown")
        .join("; ");
      throw new Error(`validator rejected params: ${message}`);
    }
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

  beforeEach(() => {
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({ ok: true });
  });

  it.each([
    [
      "update",
      { action: "update", jobId: "job-1", patch: { enabled: false } },
      { id: "job-1", patch: { enabled: false } },
    ],
    [
      "update",
      { action: "update", id: "job-2", patch: { enabled: false } },
      { id: "job-2", patch: { enabled: false } },
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
    const tool = createCronTool({ agentSessionKey: callerSessionKey });
    await tool.execute("call-session-key", {
      action: "add",
      job: {
        name: "wake-up",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "systemEvent", text: "hello" },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { sessionKey?: string };
    };
    expect(call?.params?.sessionKey).toBe(callerSessionKey);
  });

  it("preserves explicit job.sessionKey on add", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "agent:main:discord:channel:ops" });
    await tool.execute("call-explicit-session-key", {
      action: "add",
      job: {
        name: "wake-up",
        schedule: { at: new Date(123).toISOString() },
        sessionKey: "agent:main:telegram:group:-100123:topic:99",
        payload: { kind: "systemEvent", text: "hello" },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { sessionKey?: string };
    };
    expect(call?.params?.sessionKey).toBe("agent:main:telegram:group:-100123:topic:99");
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

  it("routes implicit systemEvent reminders to the current non-main session", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });
    const at = new Date(Date.now() + 10_000).toISOString();
    await tool.execute("call-implicit-current-session", {
      action: "add",
      job: {
        name: "reminder-current-session",
        schedule: { at },
        payload: { kind: "systemEvent", text: "10 秒后提醒我开会" },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: {
        sessionTarget?: string;
        payload?: { kind?: string; message?: string; text?: string };
        delivery?: { mode?: string; channel?: string; to?: string };
      };
    };
    expect(call.method).toBe("cron.add");
    expect(call.params?.sessionTarget).toBe("isolated");
    expect(call.params?.payload?.kind).toBe("agentTurn");
    expect(call.params?.payload?.message).toContain("10 秒后提醒我开会");
    expect(call.params?.payload?.text).toBeUndefined();
    expect(call.params?.delivery).toEqual({
      mode: "announce",
      channel: "discord",
      to: "buddy",
    });
    assertValid(validateCronAddParams, call.params);
  });

  it("rewrites explicit main systemEvent reminders to current non-main session delivery", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });
    await tool.execute("call-explicit-main", {
      action: "add",
      job: {
        name: "reminder-main",
        schedule: { at: new Date(123).toISOString() },
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "still main" },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: {
        sessionTarget?: string;
        payload?: { kind?: string; text?: string; message?: string };
        delivery?: unknown;
      };
    };
    expect(call.method).toBe("cron.add");
    expect(call.params?.sessionTarget).toBe("isolated");
    expect(call.params?.payload?.kind).toBe("agentTurn");
    expect(call.params?.payload?.message).toContain("still main");
    expect(call.params?.delivery).toEqual({
      mode: "announce",
      channel: "discord",
      to: "buddy",
    });
    assertValid(validateCronAddParams, call.params);
  });

  it("keeps explicit webhook main/systemEvent jobs in non-main sessions", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });
    await tool.execute("call-explicit-main-webhook", {
      action: "add",
      job: {
        name: "reminder-main-webhook",
        schedule: { at: new Date(123).toISOString() },
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "still main webhook" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: {
        sessionTarget?: string;
        payload?: { kind?: string; text?: string };
        delivery?: { mode?: string; to?: string };
      };
    };
    expect(call.method).toBe("cron.add");
    expect(call.params?.sessionTarget).toBe("main");
    expect(call.params?.payload).toEqual({ kind: "systemEvent", text: "still main webhook" });
    expect(call.params?.delivery).toEqual({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
    assertValid(validateCronAddParams, call.params);
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

  it("does not infer announce delivery when mode is webhook", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool({ agentSessionKey: "agent:main:discord:dm:buddy" });
    await tool.execute("call-webhook-explicit", {
      action: "add",
      job: {
        name: "reminder",
        schedule: { at: new Date(123).toISOString() },
        payload: { kind: "agentTurn", message: "hello" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { delivery?: { mode?: string; channel?: string; to?: string } };
    };
    expect(call?.params?.delivery).toEqual({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
  });

  it("drops non-webhook delivery for main/systemEvent jobs", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-main-drop-delivery", {
      action: "add",
      job: {
        name: "main-reminder",
        schedule: { kind: "at", at: new Date(123).toISOString() },
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: { mode: "none", channel: "last", to: "target" },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { delivery?: unknown };
    };
    expect(call?.params?.delivery).toBeUndefined();
  });

  it("keeps webhook delivery for main/systemEvent jobs", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-main-webhook", {
      action: "add",
      job: {
        name: "main-webhook",
        schedule: { kind: "at", at: new Date(123).toISOString() },
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: { delivery?: unknown };
    };
    expect(call?.params?.delivery).toEqual({
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

  it("sanitizes mixed schedule/payload fields before cron.add", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    const at = new Date(123).toISOString();
    await tool.execute("call-sanitize-add", {
      action: "add",
      job: {
        name: "sanitize-add",
        schedule: {
          kind: "at",
          at,
          everyMs: 60_000,
          anchorMs: 1,
          expr: "* * * * *",
          tz: "UTC",
        },
        sessionTarget: "main",
        payload: {
          kind: "systemEvent",
          text: "wake up",
          message: "ignore me",
          model: "gpt-test",
          thinking: "high",
          timeoutSeconds: 7,
          allowUnsafeExternalContent: true,
        },
        delivery: {
          mode: "announce",
          channel: " last ",
          to: " target ",
          bestEffort: true,
        },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      method?: string;
      params?: {
        schedule?: unknown;
        payload?: unknown;
        delivery?: unknown;
      };
    };
    expect(call.method).toBe("cron.add");
    expect(call.params?.schedule).toEqual({ kind: "at", at });
    expect(call.params?.payload).toEqual({ kind: "systemEvent", text: "wake up" });
    expect(call.params?.delivery).toBeUndefined();
  });

  it("maps agentTurn payload text fallback to message", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-agentturn-fallback", {
      action: "add",
      job: {
        name: "agentturn-fallback",
        schedule: { kind: "at", at: new Date(456).toISOString(), everyMs: 5 },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          text: "do it",
          model: "  gpt-5.2  ",
          timeoutSeconds: 3.8,
          allowUnsafeExternalContent: true,
        },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: {
        payload?: {
          kind?: string;
          message?: string;
          text?: string;
          model?: string;
          timeoutSeconds?: number;
          allowUnsafeExternalContent?: boolean;
        };
      };
    };
    expect(call.params?.payload).toEqual({
      kind: "agentTurn",
      message: "do it",
      model: "gpt-5.2",
      timeoutSeconds: 3,
      allowUnsafeExternalContent: true,
    });
    expect(call.params?.payload?.text).toBeUndefined();
  });

  it("sanitizes update patch schedule/payload by kind and drops unknown keys", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    const tool = createCronTool();
    await tool.execute("call-update-sanitize", {
      action: "update",
      jobId: "job-update",
      patch: {
        foo: "bar",
        sessionTarget: " Main ",
        wakeMode: "NOW",
        schedule: {
          kind: "cron",
          expr: " 0 9 * * * ",
          at: new Date(123).toISOString(),
          everyMs: 10,
          anchorMs: 2,
          tz: " Asia/Shanghai ",
        },
        payload: {
          kind: "systemEvent",
          text: "  summarize  ",
          message: "ignore",
          model: "unused",
        },
        delivery: {
          mode: "announce",
          channel: " last ",
          to: " room-1 ",
          bestEffort: true,
        },
        state: {
          nextRunAtMs: 100.8,
          lastStatus: "ok",
          lastError: "none",
          consecutiveErrors: 2.4,
          scheduleErrorCount: 99,
        },
      },
    });

    const call = callGatewayMock.mock.calls[0]?.[0] as {
      params?: {
        patch?: Record<string, unknown>;
      };
    };
    const patch = call.params?.patch as Record<string, unknown>;
    expect("foo" in patch).toBe(false);
    expect(patch.sessionTarget).toBe("main");
    expect(patch.wakeMode).toBe("now");
    expect(patch.schedule).toEqual({ kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" });
    expect(patch.payload).toEqual({ kind: "systemEvent", text: "summarize" });
    expect(patch.delivery).toEqual({
      mode: "announce",
      channel: "last",
      to: "room-1",
      bestEffort: true,
    });
    expect(patch.state).toEqual({
      nextRunAtMs: 100,
      lastStatus: "ok",
      lastError: "none",
      consecutiveErrors: 2,
    });
  });

  it.each([
    [
      "at + systemEvent",
      {
        name: "at-system",
        schedule: {
          kind: "at",
          at: new Date(111).toISOString(),
          everyMs: 60_000,
          expr: "* * * * *",
        },
        sessionTarget: "main",
        wakeMode: "NOW",
        payload: {
          kind: "systemEvent",
          text: "wake up",
          message: "ignore me",
          model: "unused",
        },
        extraField: "drop-me",
      },
    ],
    [
      "every + inferred main/systemEvent",
      {
        name: "every-system",
        schedule: {
          kind: "every",
          everyMs: 901.7,
          anchorMs: 50.4,
          at: new Date(222).toISOString(),
        },
        payload: {
          text: "tick",
        },
      },
    ],
    [
      "cron + isolated/agentTurn",
      {
        name: "cron-agent",
        schedule: {
          kind: "cron",
          expr: " */5 * * * * ",
          tz: " UTC ",
          at: new Date(333).toISOString(),
        },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          text: "  summarize  ",
          model: " gpt-5.2 ",
          timeoutSeconds: 9.9,
          allowUnsafeExternalContent: true,
          channel: " telegram ",
          to: " 123 ",
          bestEffortDeliver: true,
        },
        delivery: {
          mode: "announce",
          channel: " last ",
          to: " room ",
          bestEffort: true,
        },
      },
    ],
  ])("emits gateway-valid cron.add params for %s", async (_label, job) => {
    const tool = createCronTool();
    await tool.execute("call-add-validator", {
      action: "add",
      job,
    });

    const call = readGatewayCall(0);
    expect(call.method).toBe("cron.add");
    assertValid(validateCronAddParams, call.params);
  });

  it.each([
    [
      "schedule+systemEvent patch",
      {
        schedule: {
          kind: "cron",
          expr: " 0 9 * * * ",
          at: new Date(444).toISOString(),
          everyMs: 5,
          tz: " Asia/Shanghai ",
        },
        payload: {
          kind: "systemEvent",
          text: "  remind  ",
          message: "ignore",
        },
        delivery: {
          mode: "announce",
          channel: " last ",
          to: " room ",
          bestEffort: true,
        },
        foo: "drop-me",
      },
    ],
    [
      "agentTurn model-only patch",
      {
        payload: {
          kind: "agentTurn",
          model: " gpt-5.2 ",
          thinking: " high ",
          timeoutSeconds: 8.8,
        },
      },
    ],
    [
      "state-only patch",
      {
        state: {
          nextRunAtMs: 100.9,
          lastStatus: "ok",
          lastError: "none",
          consecutiveErrors: 3.2,
          unknown: "drop-me",
        },
      },
    ],
  ])("emits gateway-valid cron.update params for %s", async (_label, patch) => {
    const tool = createCronTool();
    await tool.execute("call-update-validator", {
      action: "update",
      jobId: "job-validator",
      patch,
    });

    const call = readGatewayCall(0);
    expect(call.method).toBe("cron.update");
    assertValid(validateCronUpdateParams, call.params);
  });

  it("emits gateway-valid params for status/list/remove/run/runs/wake", async () => {
    const tool = createCronTool();

    await tool.execute("call-status", { action: "status" });
    assertValid(validateCronStatusParams, readGatewayCall(0).params);

    await tool.execute("call-list", { action: "list", includeDisabled: true });
    assertValid(validateCronListParams, readGatewayCall(1).params);

    await tool.execute("call-remove", { action: "remove", jobId: "job-rm" });
    assertValid(validateCronRemoveParams, readGatewayCall(2).params);

    await tool.execute("call-run", { action: "run", jobId: "job-run", runMode: "due" });
    assertValid(validateCronRunParams, readGatewayCall(3).params);

    await tool.execute("call-runs", { action: "runs", id: "job-runs" });
    assertValid(validateCronRunsParams, readGatewayCall(4).params);

    await tool.execute("call-wake", { action: "wake", text: "wake up", mode: "now" });
    assertValid(validateWakeParams, readGatewayCall(5).params);
  });

  it("falls back to default gateway timeout when timeoutMs is too small", async () => {
    const tool = createCronTool();
    await tool.execute("call-timeout-default", {
      action: "status",
      timeoutMs: 0,
    });

    const call = readGatewayCall(0) as { timeoutMs?: number };
    expect(call.timeoutMs).toBe(60_000);
  });

  it("uses explicit gateway timeout when timeoutMs is valid", async () => {
    const tool = createCronTool();
    await tool.execute("call-timeout-explicit", {
      action: "status",
      timeoutMs: 5_000,
    });

    const call = readGatewayCall(0) as { timeoutMs?: number };
    expect(call.timeoutMs).toBe(5_000);
  });

  it("exposes structured add-job schema to guide tool-call generation", () => {
    const tool = createCronTool();
    const properties =
      (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    const job = properties.job as
      | {
          type?: string;
          required?: string[];
          properties?: Record<string, unknown>;
        }
      | undefined;

    expect(job?.type).toBe("object");
    expect(job?.required ?? []).toEqual(
      expect.arrayContaining(["name", "schedule", "sessionTarget", "payload"]),
    );

    const jobProps = job?.properties ?? {};
    expect(jobProps.schedule).toBeDefined();
    expect(jobProps.payload).toBeDefined();
  });

  it("keeps flat recovery fields in schema for non-frontier models", () => {
    const tool = createCronTool();
    const properties =
      (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};

    expect(properties.name).toBeDefined();
    expect(properties.schedule).toBeDefined();
    expect(properties.sessionTarget).toBeDefined();
    expect(properties.payload).toBeDefined();
    expect(properties.message).toBeDefined();
    expect(properties.text).toBeDefined();
  });

  it("keeps provider-safe schema keywords", () => {
    const tool = createCronTool();
    const raw = JSON.stringify(tool.parameters);
    expect(raw).not.toContain('"anyOf"');
    expect(raw).not.toContain('"oneOf"');
    expect(raw).not.toContain('"allOf"');
  });
});
