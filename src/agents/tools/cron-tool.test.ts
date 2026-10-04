import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayMock, extractDeliveryInfoMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  extractDeliveryInfoMock: vi.fn(),
}));

vi.mock("../../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: extractDeliveryInfoMock,
}));

import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import { textAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { createCronTool } from "./cron-tool.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";

describe("cron tool", () => {
  type TestDelivery = {
    mode?: string;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };

  function createTestCronTool(
    opts?: Parameters<typeof createCronTool>[0],
  ): ReturnType<typeof createCronTool> {
    return createCronTool(opts, {
      callGatewayTool: async (method, gatewayOpts, params) => {
        const result = await callGatewayMock({ method, params }, gatewayOpts);
        if (
          method === "cron.get" &&
          result !== null &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          Object.hasOwn(result, "payload") &&
          !Object.hasOwn(result, "configRevision")
        ) {
          return { ...result, configRevision: "sha256:test" };
        }
        return result;
      },
    });
  }

  function executeCron(args: Record<string, unknown>, opts?: Parameters<typeof createCronTool>[0]) {
    return createTestCronTool(opts).execute("cron", args);
  }

  function readGatewayCall(index = 0): { method?: string; params?: Record<string, unknown> } {
    return (
      (callGatewayMock.mock.calls[index]?.[0] as
        | { method?: string; params?: Record<string, unknown> }
        | undefined) ?? { method: undefined, params: undefined }
    );
  }

  function readGatewayOpts(index = 0): Record<string, unknown> | undefined {
    return callGatewayMock.mock.calls[index]?.[1] as Record<string, unknown> | undefined;
  }

  function readCronPayloadText(index = 0): string {
    const params = readGatewayCall(index).params as { payload?: { text?: string } } | undefined;
    return params?.payload?.text ?? "";
  }

  function expectSingleGatewayCallMethod(method: string) {
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const call = readGatewayCall(0);
    expect(call.method).toBe(method);
    return call.params;
  }

  function buildReminderAgentTurnJob() {
    return {
      name: "reminder",
      schedule: { at: new Date(123).toISOString() },
      payload: { kind: "agentTurn" as const, message: "hello" },
    };
  }

  async function executeAddAndReadDelivery(params: {
    callId: string;
    agentSessionKey?: string;
    currentDeliveryContext?: NonNullable<
      Parameters<typeof createCronTool>[0]
    >["currentDeliveryContext"];
    delivery?: TestDelivery | null;
  }) {
    const tool = createTestCronTool({
      agentSessionKey: params.agentSessionKey,
      currentDeliveryContext: params.currentDeliveryContext,
    });
    await tool.execute(params.callId, {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
      },
    });

    return (readGatewayCall().params as { delivery?: TestDelivery } | undefined)?.delivery;
  }

  async function executeAddWithContextMessages(callId: string, contextMessages: number) {
    const tool = createTestCronTool({ agentSessionKey: "main" });
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
    extractDeliveryInfoMock.mockReset();
    extractDeliveryInfoMock.mockReturnValue({ deliveryContext: undefined, threadId: undefined });
  });

  it("allows scoped isolated cron runs to remove the current job", async () => {
    // Self-removal scope lets a cron-triggered run clean up its own schedule
    // without granting broad cron mutation access.

    await executeCron(
      {
        action: "remove",
        jobId: "job-current",
      },
      {
        agentSessionKey: "main",
        selfRemoveOnlyJobId: "job-current",
      },
    );

    const params = expectSingleGatewayCallMethod("cron.remove");
    expect(params).toEqual({ id: "job-current" });
  });

  it("denies scoped isolated cron runs from removing another job", async () => {
    await expect(
      executeCron(
        {
          action: "remove",
          jobId: "job-other",
        },
        {
          agentSessionKey: "main",
          selfRemoveOnlyJobId: "job-current",
        },
      ),
    ).rejects.toThrow("Automations tool is restricted to the current automation.");

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("redacts global status while preserving authenticated caller identity", async () => {
    let identity: ReturnType<typeof getGatewayToolCallerIdentity>;
    callGatewayMock.mockImplementation(async () => {
      identity = getGatewayToolCallerIdentity();
      return { enabled: true, jobs: 37, storePath: "/synthetic/state.sqlite", nextWakeAtMs: 1234 };
    });

    const result = await executeCron(
      { action: "status", timeoutMs: "5000" },
      {
        agentSessionKey: "agent:main:discord:channel:ops",
        agentAccountId: "source-account",
        selfRemoveOnlyJobId: "job-current",
        currentDeliveryContext: { accountId: "delivery-account" },
      },
    );
    expect(expectSingleGatewayCallMethod("cron.status")).toEqual({});
    expect(result.details).toEqual({ enabled: true });
    expect(readGatewayOpts()?.timeoutMs).toBe(5000);
    expect(identity).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:discord:channel:ops",
      turnSourceAccountId: "source-account",
      cronSelfManagementJobId: "job-current",
    });
  });

  function listPage(
    jobs: Array<{ id: string; name?: string }>,
    revision: string,
    total: number,
    offset = 0,
    nextOffset: number | null = null,
  ) {
    return {
      jobs,
      snapshotRevision: revision,
      total,
      offset,
      limit: 200,
      hasMore: nextOffset !== null,
      nextOffset,
    };
  }
  const otherJobs = Array.from({ length: 200 }, (_, i) => ({ id: `other-${i}` }));
  const currentJob = { id: "job-current", name: "current" };
  const selfInventory = {
    jobs: [currentJob],
    total: 1,
    offset: 0,
    limit: 1,
    hasMore: false,
    nextOffset: null,
  };

  it("pages only the current automation and hides other jobs, previews, and inventory metadata", async () => {
    callGatewayMock
      .mockResolvedValueOnce(listPage(otherJobs, "stable", 202, 0, 200))
      .mockResolvedValueOnce({
        ...listPage([currentJob, { id: "private" }], "stable", 202, 200),
        deliveryPreviews: {
          "job-current": { label: "current", detail: "self" },
          private: { label: "secret" },
        },
      });

    const result = await executeCron(
      {
        action: "list",
        includeDisabled: true,
        limit: 1,
        offset: 200,
      },
      {
        agentSessionKey: "agent:agent-123:cron:job-current:run:abc",
        selfRemoveOnlyJobId: "job-current",
      },
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expect(callGatewayMock.mock.calls.map(([call]) => call)).toEqual([
      {
        method: "cron.list",
        params: { includeDisabled: true, compact: true, limit: 200, offset: 0 },
      },
      {
        method: "cron.list",
        params: { includeDisabled: true, compact: true, limit: 200, offset: 200 },
      },
    ]);
    expect(result.details).toEqual({
      ...selfInventory,
      deliveryPreviews: { "job-current": { label: "current", detail: "self" } },
    });
  });

  it("restarts the scoped list when the current job moves behind the page boundary", async () => {
    callGatewayMock
      .mockResolvedValueOnce(listPage(otherJobs, "before", 201, 0, 200))
      .mockResolvedValueOnce(listPage([], "after", 200, 200))
      .mockResolvedValueOnce(listPage([...otherJobs.slice(0, 199), currentJob], "after", 200));

    const result = await executeCron({ action: "list" }, { selfRemoveOnlyJobId: "job-current" });
    expect(callGatewayMock.mock.calls.map(([call]) => call.params.offset)).toEqual([0, 200, 0]);
    expect(result.details).toEqual(selfInventory);
  });

  it("rejects a scoped list after repeated snapshot churn", async () => {
    callGatewayMock.mockImplementation(async ({ params }: { params: Record<string, unknown> }) =>
      params.offset === 0
        ? listPage(otherJobs, `revision-${callGatewayMock.mock.calls.length}`, 201, 0, 200)
        : listPage([], `revision-${callGatewayMock.mock.calls.length}`, 200, 200),
    );

    await expect(
      executeCron({ action: "list" }, { selfRemoveOnlyJobId: "job-current" }),
    ).rejects.toThrow("cron.list inventory changed repeatedly while reading current automation");
    expect(callGatewayMock).toHaveBeenCalledTimes(8);
  });

  it.each([["add", { action: "add", job: buildReminderAgentTurnJob() }]])(
    "denies scoped isolated cron runs from using %s",
    async (_action, args) => {
      await expect(executeCron(args, { selfRemoveOnlyJobId: "job-current" })).rejects.toThrow(
        "Automations tool is restricted to the current automation.",
      );

      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it("forwards caller identity for Gateway-scoped listing without imposing an agent filter", async () => {
    let identity: ReturnType<typeof getGatewayToolCallerIdentity>;
    callGatewayMock.mockImplementation(async () => {
      identity = getGatewayToolCallerIdentity();
      return { jobs: [] };
    });

    await executeCron(
      {
        action: "list",
      },
      {
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      },
    );

    const params = expectSingleGatewayCallMethod("cron.list");
    expect(params).toEqual({
      includeDisabled: false,
      compact: true,
    });
    expect(identity).toMatchObject({
      agentId: "agent-123",
      sessionKey: "agent:agent-123:telegram:direct:channing",
    });
  });

  it("preserves explicit agentId for sessionless cron list callers", async () => {
    await executeCron({
      action: "list",
      agentId: "worker",
      includeDisabled: true,
      limit: 200,
      offset: 200,
    });

    const params = expectSingleGatewayCallMethod("cron.list");
    expect(params).toEqual({
      includeDisabled: true,
      compact: true,
      agentId: "worker",
      limit: 200,
      offset: 200,
    });
  });

  it.each([
    ["oversized limit", { limit: 201 }],
    ["malformed limit", { limit: "1x" }],
    ["negative offset", { offset: -1 }],
  ])("rejects a %s before calling the cron gateway", async (_label, pagination) => {
    await expect(executeCron({ action: "list", ...pagination })).rejects.toThrow(
      /(?:limit|offset) must be a (?:positive|non-negative) integer/,
    );

    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  describe("wake routing", () => {
    // Pin the agentId / sessionKey resolution contract for `action: "wake"`.
    // The gateway target resolver treats `agentId` as authoritative, so
    // pairing the caller's inferred agentId with a foreign explicit
    // sessionKey would canonicalize the wake back to the caller agent's
    // main lane.

    it("infers sessionKey + agentId from the calling agent's session when neither is supplied", async () => {
      const tool = createTestCronTool({
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      });
      await tool.execute("call-wake-default", { action: "wake", text: "ping", mode: "now" });
      const params = expectSingleGatewayCallMethod("wake");
      expect(params).toEqual({
        mode: "now",
        text: "ping",
        sessionKey: "agent:agent-123:telegram:direct:channing",
        agentId: "agent-123",
      });
    });

    it("preserves a contradictory explicit target for Gateway-owned validation", async () => {
      const tool = createTestCronTool();
      await tool.execute("call-wake-explicit-pair", {
        action: "wake",
        text: "manual",
        sessionKey: "agent:agent-456:discord:thread-xyz",
        agentId: "ops",
      });
      expect(expectSingleGatewayCallMethod("wake")).toEqual({
        mode: "next-heartbeat",
        text: "manual",
        sessionKey: "agent:agent-456:discord:thread-xyz",
        agentId: "ops",
      });
    });

    it("forwards an unparseable explicit sessionKey for Gateway-owned caller binding", async () => {
      const tool = createTestCronTool({
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      });
      await tool.execute("call-wake-unparseable", {
        action: "wake",
        text: "x",
        sessionKey: "subagent:weird:format",
      });
      const params = expectSingleGatewayCallMethod("wake");
      expect(params).toEqual({
        mode: "next-heartbeat",
        text: "x",
        sessionKey: "subagent:weird:format",
      });
    });

    it("requires text for action wake", async () => {
      // Mutation-test survivor: `required: true` -> false silently sent an
      // undefined-text wake. Pin the guard.
      const tool = createTestCronTool({
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      });
      await expect(tool.execute("call-wake-no-text", { action: "wake" })).rejects.toThrow();
      expect(callGatewayMock).not.toHaveBeenCalled();
    });
  });

  it.each([true])("preserves scoped lookup recovery guidance when triggers=%s", (enabled) => {
    const tool = createTestCronTool({ config: { cron: { triggers: { enabled } } } });

    // A scoped miss must not turn an update/remove request into a duplicate automation.
    expect(tool.description).toContain(
      "an empty list or failed list/get/update/remove (including not-found) does not establish global absence",
    );
    expect(tool.description).toContain("Never recreate or replace a known automation");
    expect(tool.description).toContain("ask an authorized administrator");
  });

  it("prefers jobId over id when both are provided", async () => {
    await executeCron({
      action: "run",
      jobId: "job-primary",
      id: "job-legacy",
      runMode: "force",
    });

    expect(readGatewayCall().params).toEqual({
      id: "job-primary",
      mode: "force",
      waitTimeoutMs: 60_000,
    });
  });

  it("caps the run wait so one call cannot hold the turn past ten minutes", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true, enqueued: true, runId: "manual:job:1" });
    const result = await executeCron({
      action: "run",
      jobId: "job",
      runMode: "force",
      timeoutMs: 3_600_000,
    });

    expect(readGatewayCall().params).toMatchObject({ waitTimeoutMs: 600_000 });
    expect(readGatewayOpts()).toMatchObject({ timeoutMs: 660_000 });
    // A run still going when the wait ends points at runs, not a scheduled check.
    expect(result.details).toMatchObject({
      runId: "manual:job:1",
      note: expect.stringContaining("runs jobId runId"),
    });
  });

  it("normalizes cron.add job payloads", async () => {
    await executeCron({
      action: "add",
      job: {
        data: {
          name: "wake-up",
          schedule: { atMs: 123 },
          payload: { kind: "systemEvent", text: "hello" },
        },
      },
    });

    const params = expectSingleGatewayCallMethod("cron.add");
    expect(params).toEqual({
      name: "wake-up",
      enabled: true,
      deleteAfterRun: true,
      schedule: { kind: "at", at: new Date(123).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });
  });

  it("preserves omitted declaration enablement and forwards explicit enablement", async () => {
    const tool = createTestCronTool();
    const baseJob = {
      name: "wake-up",
      declarationKey: "daily-wake",
      schedule: { at: new Date(123).toISOString() },
      payload: { kind: "systemEvent" as const, text: "hello" },
    };

    await tool.execute("call-declaration-default", { action: "add", job: baseJob });
    expect(readGatewayCall(0).params).not.toHaveProperty("enabled");

    await tool.execute("call-declaration-disabled", {
      action: "add",
      job: { ...baseJob, enabled: false },
    });
    expect(readGatewayCall(1).params).toMatchObject({ enabled: false });
  });

  it("rejects blank declaration keys before create normalization", async () => {
    await expect(
      executeCron({
        action: "add",
        job: {
          name: "wake-up",
          declarationKey: "   ",
          schedule: { at: new Date(123).toISOString() },
          payload: { kind: "systemEvent", text: "hello" },
        },
      }),
    ).rejects.toThrow("declarationKey must be a non-empty string");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects blank display names before create and patch normalization", async () => {
    const tool = createTestCronTool();
    await expect(
      tool.execute("call-blank-display-add", {
        action: "add",
        job: {
          name: "wake-up",
          declarationKey: "daily",
          displayName: "   ",
          schedule: { at: new Date(123).toISOString() },
          payload: { kind: "systemEvent", text: "hello" },
        },
      }),
    ).rejects.toThrow("displayName must be a non-empty string");
    await expect(
      tool.execute("call-blank-display-update", {
        action: "update",
        jobId: "daily",
        job: { displayName: "   " },
      }),
    ).rejects.toThrow("displayName must be a non-empty string or null");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "add",
      {
        action: "add",
        job: { ...buildReminderAgentTurnJob(), pacing: {} },
      },
    ],
    [
      "update",
      {
        action: "update",
        jobId: "paced-job",
        job: { pacing: {} },
      },
    ],
  ])("rejects empty pacing on cron.%s before calling the gateway", async (_action, args) => {
    await expect(executeCron(args)).rejects.toThrow(
      "cron pacing requires at least one of min or max",
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([["null", { agentId: null }]])(
    "forwards %s add ownership separately from authenticated caller identity",
    async (_name, fields) => {
      let identity: ReturnType<typeof getGatewayToolCallerIdentity>;
      callGatewayMock.mockImplementation(async () => {
        identity = getGatewayToolCallerIdentity();
        return { ok: true };
      });

      await executeCron(
        {
          action: "add",
          job: { ...buildReminderAgentTurnJob(), ...fields },
        },
        {
          agentSessionKey: "agent:agent-123:telegram:direct:channing",
        },
      );
      expect(expectSingleGatewayCallMethod("cron.add")?.agentId).toBe(
        "agentId" in fields ? fields.agentId : undefined,
      );
      expect(identity).toMatchObject({
        agentId: "agent-123",
        sessionKey: "agent:agent-123:telegram:direct:channing",
      });
    },
  );

  it("does not forward model-supplied callerScope", async () => {
    await executeCron(
      {
        action: "remove",
        jobId: "job-1",
        callerScope: { kind: "agentTool", agentId: "worker" },
      },
      {
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
      },
    );

    expect(readGatewayCall().params).toEqual({
      id: "job-1",
    });
  });

  it("rejects mixed-case command payloads from the agent cron tool on add", async () => {
    await expect(
      executeCron({
        action: "add",
        job: {
          name: "command",
          schedule: { at: new Date(123).toISOString() },
          sessionTarget: "isolated",
          payload: { kind: "Command", argv: ["sh", "-lc", "echo ok"] },
        },
      }),
    ).rejects.toThrow("automation command payloads cannot be created or edited");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([["delivery.channel", { channel: " ", to: "chat-1" }]])(
    "rejects invalid cron.add %s before gateway normalization",
    async (field, delivery) => {
      await expect(
        executeCron({
          action: "add",
          job: {
            name: "reminder",
            schedule: { at: new Date(123).toISOString() },
            payload: { kind: "agentTurn", message: "hello" },
            delivery,
          },
        }),
      ).rejects.toThrow(`${field} must be a non-empty string`);
      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it("recovers flattened add params for failureAlert and payload extras", async () => {
    await executeCron({
      action: "add",
      name: "reminder",
      schedule: { at: new Date(123).toISOString() },
      message: "hello",
      lightContext: true,
      fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
      failureAlert: { after: 3, cooldownMs: 60_000 },
    });

    const params = expectSingleGatewayCallMethod("cron.add");
    expect(params).toHaveProperty("payload", {
      kind: "agentTurn",
      message: "hello",
      lightContext: true,
      fallbacks: ["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"],
    });
    expect(params).toHaveProperty("failureAlert", { after: 3, cooldownMs: 60_000 });
  });

  it("recovers flat concatenated cron add keys from local tool-call parsers", async () => {
    await executeCron({
      action: "add",
      delivery: { mode: "none" },
      enabled: true,
      namePayload: { kind: "agentTurn", message: "Evidence test.", timeoutSeconds: 10 },
      scheduleKind: { everyMs: 999_999, kind: "every" },
      sessionTargetName: "evidence-test",
    });

    const params = expectSingleGatewayCallMethod("cron.add");
    expect(params).toEqual({
      delivery: { mode: "none" },
      enabled: true,
      name: "evidence-test",
      payload: { kind: "agentTurn", message: "Evidence test.", timeoutSeconds: 10 },
      schedule: { everyMs: 999_999, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "now",
    });
  });

  it("defaults scoped agentTurn adds to the creating conversation", async () => {
    const callerSessionKey = "agent:main:discord:channel:ops";

    await executeCron(
      {
        action: "add",
        job: buildReminderAgentTurnJob(),
      },
      { agentSessionKey: callerSessionKey },
    );

    expect(expectSingleGatewayCallMethod("cron.add")).toMatchObject({
      sessionTarget: "current",
      sessionKey: callerSessionKey,
      delivery: { mode: "announce" },
    });
  });

  it("does not stamp caller sessionKey when add targets isolated session", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    await executeCron(
      {
        action: "add",
        job: {
          name: "isolated run",
          schedule: { at: new Date(123).toISOString() },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "hello" },
        },
      },
      { agentSessionKey: "agent:main:webchat:dm:dashboard" },
    );
    const call = readGatewayCall();
    const payload = call.params as { sessionKey?: string; sessionTarget?: string } | undefined;
    expect(payload?.sessionTarget).toBe("isolated");
    expect(payload).not.toHaveProperty("sessionKey");
  });

  it("caps contextMessages at 10", async () => {
    const messages = Array.from({ length: 12 }, (_, idx) =>
      idx === 11
        ? textAssistant("Message 12")
        : { role: "user", content: [{ type: "text", text: `Message ${idx + 1}` }] },
    );
    callGatewayMock.mockResolvedValueOnce({ messages }).mockResolvedValueOnce({ ok: true });

    await executeAddWithContextMessages("call5", 20);

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    const historyCall = readGatewayCall(0);
    expect(historyCall.method).toBe("chat.history");
    const historyParams = historyCall.params as { limit?: number } | undefined;
    expect(historyParams?.limit).toBe(10);

    const text = readCronPayloadText(1);
    expect(text).not.toMatch(/Message 1\b/);
    expect(text).not.toMatch(/Message 2\b/);
    expect(text).toContain("Recent context:");
    expect(text).toContain("User: Message 3");
    expect(text).toContain("Assistant: Message 12");
  });

  it.each(["2messages"])("rejects invalid contextMessages value %s", async (contextMessages) => {
    await expect(
      executeCron(
        {
          action: "add",
          contextMessages,
          job: {
            name: "reminder",
            schedule: { at: new Date(123).toISOString() },
            payload: { kind: "systemEvent", text: "Reminder: the thing." },
          },
        },
        { agentSessionKey: "main" },
      ),
    ).rejects.toThrow("contextMessages must be a non-negative integer");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("strips null clears from add jobs before the strict gateway create contract (#121606)", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    await executeCron({
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        displayName: null,
        pacing: null,
        trigger: null,
        sessionKey: null,
        payload: { kind: "agentTurn", message: "hello", model: null, fallbacks: null },
        delivery: { mode: "announce", channel: null, failureDestination: null },
      },
    });

    const call = readGatewayCall();
    expect(call.method).toBe("cron.add");
    const params = call.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("displayName");
    expect(params).not.toHaveProperty("pacing");
    expect(params).not.toHaveProperty("trigger");
    // Null sessionKey stays: cron.add accepts it and it suppresses default
    // creator-session binding.
    expect(params.sessionKey).toBeNull();
    expect(params.payload).not.toHaveProperty("model");
    expect(params.payload).not.toHaveProperty("fallbacks");
    expect(params.delivery).not.toHaveProperty("channel");
    expect(params.delivery).not.toHaveProperty("failureDestination");
  });

  it("does not surface lowercased LINE recipients when current delivery context is unavailable (#81628)", async () => {
    // LINE chat IDs are case-sensitive; without current/persisted deliveryContext,
    // cron must not rebuild delivery.to from the lowercased session-key fragment.
    const sessionKey = buildAgentPeerSessionKey({
      agentId: "main",
      channel: "line",
      peerKind: "group",
      peerId: "Cabcdef0123456789abcdef0123456789",
    });
    expect(sessionKey).toBe("agent:main:line:group:cabcdef0123456789abcdef0123456789");

    const delivery = await executeAddAndReadDelivery({
      callId: "call-line-group-no-context-81628",
      agentSessionKey: sessionKey,
      // Intentionally no currentDeliveryContext.
    });

    expect(delivery?.to).toBeUndefined();
  });

  it("does not let current delivery context override explicit delivery targets", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-explicit-target-wins",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "room:!AbCdEf1234567890:example.org",
        },
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "-100123",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-100123",
    });
  });

  it("keeps explicit delivery account and thread while filling target from context", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-explicit-delivery-fields-win",
        agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
        currentDeliveryContext: {
          channel: "matrix",
          to: "!AbCdEf1234567890:example.org",
          accountId: "context-bot",
          threadId: "$ContextThread:Example.Org",
        },
        delivery: {
          mode: "announce",
          accountId: "explicit-bot",
          threadId: "$ExplicitThread:Example.Org",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "!AbCdEf1234567890:example.org",
      accountId: "explicit-bot",
      threadId: "$ExplicitThread:Example.Org",
    });
  });

  it("infers delivery from current context even when no session key is available", async () => {
    expect(
      await executeAddAndReadDelivery({
        callId: "call-context-no-session",
        currentDeliveryContext: {
          channel: "matrix",
          to: "!AbCdEf1234567890:example.org",
        },
      }),
    ).toEqual({
      mode: "announce",
      channel: "matrix",
      to: "!AbCdEf1234567890:example.org",
    });
  });

  it("recovers flat text as a systemEvent payload", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    await executeCron({
      action: "add",
      name: "flat-system-event",
      schedule: { kind: "every", everyMs: 60_000 },
      text: "tick",
    });

    const params = expectSingleGatewayCallMethod("cron.add");
    expect(params).toHaveProperty("payload", {
      kind: "systemEvent",
      text: "tick",
    });
  });

  it("does not recover flat params when no meaningful job field is present", async () => {
    await expect(
      executeCron({
        action: "add",
        name: "orphan-name",
        enabled: true,
      }),
    ).rejects.toThrow("job required");
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

  it("fails fast when webhook mode uses a non-http URL", async () => {
    await expect(
      executeCron(
        {
          action: "add",
          job: {
            ...buildReminderAgentTurnJob(),
            delivery: { mode: "webhook", to: "ftp://example.invalid/cron-finished" },
          },
        },
        { agentSessionKey: "agent:main:discord:dm:buddy" },
      ),
    ).rejects.toThrow('delivery.mode="webhook" requires delivery.to to be a valid http(s) URL');
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["delivery.completionDestination.to", { completionDestination: { mode: "webhook", to: " " } }],
  ])("rejects invalid cron.update %s before gateway normalization", async (field, delivery) => {
    await expect(
      executeCron({
        action: "update",
        id: "job-blank-delivery",
        job: { delivery },
      }),
    ).rejects.toThrow(`${field} must be a non-empty string`);
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects mixed-case command payloads from the agent cron tool on update", async () => {
    await expect(
      executeCron({
        action: "update",
        id: "job-4",
        job: {
          payload: { kind: "Command", argv: ["sh", "-lc", "echo ok"] },
        },
      }),
    ).rejects.toThrow("automation command payloads cannot be created or edited");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("rejects kind-less edits to stored command payloads", async () => {
    callGatewayMock.mockResolvedValueOnce({
      id: "job-command",
      trigger: { script: "json({ fire: true })" },
      payload: { kind: "command", argv: ["echo", "before"] },
    });

    await expect(
      executeCron({
        action: "update",
        id: "job-command",
        job: {
          payload: { argv: ["sh", "-lc", "echo bypass"] },
        },
      }),
    ).rejects.toThrow("automation command payloads cannot be created or edited");

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(readGatewayCall()).toEqual({
      method: "cron.get",
      params: { id: "job-command" },
    });
  });

  it("recovers flattened model-only payload patch params for update action", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-5",
        configRevision: "sha256:model-only",
        payload: { kind: "agentTurn", message: "before" },
      })
      .mockResolvedValueOnce({ ok: true });

    await executeCron({
      action: "update",
      id: "job-5",
      model: " openrouter/deepseek/deepseek-r1 ",
      fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
    });

    const params = readGatewayCall(1).params;
    expect(params).toHaveProperty("id", "job-5");
    expect(params).toHaveProperty("patch.payload", {
      kind: "agentTurn",
      model: "openrouter/deepseek/deepseek-r1",
      fallbacks: ["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"],
    });
  });

  it("uses flat string scheduleKind without leaking it to cron update", async () => {
    callGatewayMock.mockResolvedValueOnce({ ok: true });

    await executeCron({
      action: "update",
      id: "job-kind",
      expr: "0 8 * * *",
      scheduleKind: "cron",
    });

    const params = expectSingleGatewayCallMethod("cron.update");
    expect(params).toHaveProperty("id", "job-kind");
    expect(params).toHaveProperty("patch", { schedule: { expr: "0 8 * * *", kind: "cron" } });
  });

  it("rejects malformed flattened fallback-only payload patch params for update action", async () => {
    await expect(
      executeCron({
        action: "update",
        id: "job-9",
        fallbacks: [123],
      }),
    ).rejects.toThrow("job required");
    expect(callGatewayMock).toHaveBeenCalledTimes(0);
  });

  it("clears a legacy per-job tool list using the current revision", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-8",
        payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
      })
      .mockResolvedValueOnce({ ok: true });

    await executeCron(
      {
        action: "update",
        id: "job-8",
        job: {
          payload: {
            toolsAllow: null,
          },
        },
      },
      {
        agentSessionKey: "agent:main:telegram:group:restricted-room",
        creatorToolAllowlist: ["read", "cron"],
      },
    );

    const params = readGatewayCall(1).params;
    expect(params).toHaveProperty("patch.payload", {
      kind: "agentTurn",
      toolsAllow: null,
    });
  });

  it("updates payload metadata with the stored revision without rediscovering tools", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-metadata",
        configRevision: "sha256:metadata",
        payload: {
          kind: "agentTurn",
          message: "before",
          toolsAllow: ["read", "configured__lookup"],
          toolsAllowIsDefault: true,
        },
      })
      .mockResolvedValueOnce({ ok: true });
    const resolveCreatorToolAuthority = vi.fn(async () => {
      throw new Error("metadata update must stay offline");
    });

    await executeCron(
      {
        action: "update",
        id: "job-metadata",
        job: { payload: { kind: "agentTurn", message: "after" } },
      },
      {
        agentSessionKey: "agent:main:main",
        resolveCreatorToolAuthority,
      },
    );

    expect(resolveCreatorToolAuthority).not.toHaveBeenCalled();
    expect(readGatewayCall(1)).toEqual({
      method: "cron.update",
      params: {
        id: "job-metadata",
        expectedConfigRevision: "sha256:metadata",
        patch: { payload: { kind: "agentTurn", message: "after" } },
      },
    });
  });

  it("rechecks the payload and revision after a concurrent cron job update", async () => {
    const conflict = Object.assign(
      new Error("cron job definition no longer matches the loaded version"),
      {
        name: "GatewayClientRequestError",
        details: {
          code: "CRON_JOB_CHANGED",
          expectedConfigRevision: "sha256:first",
          actualConfigRevision: "sha256:second",
        },
      },
    );
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-race",
        configRevision: "sha256:first",
        payload: { kind: "agentTurn", message: "hello", toolsAllow: ["read"] },
      })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        id: "job-race",
        configRevision: "sha256:second",
        payload: { kind: "agentTurn", message: "hello", toolsAllow: [] },
      })
      .mockResolvedValueOnce({ ok: true });

    const tool = createTestCronTool();
    await tool.execute("call-update-revision-race", {
      action: "update",
      id: "job-race",
      job: { payload: { message: "updated" } },
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(4);
    expect(readGatewayCall(1)).toEqual({
      method: "cron.update",
      params: {
        id: "job-race",
        expectedConfigRevision: "sha256:first",
        patch: { payload: { kind: "agentTurn", message: "updated" } },
      },
    });
    expect(readGatewayCall(3)).toEqual({
      method: "cron.update",
      params: {
        id: "job-race",
        expectedConfigRevision: "sha256:second",
        patch: { payload: { kind: "agentTurn", message: "updated" } },
      },
    });
  });

  it("fails closed when cron.get omits the update revision", async () => {
    callGatewayMock.mockResolvedValueOnce({
      id: "job-no-revision",
      configRevision: null,
      payload: { kind: "agentTurn", message: "hello", toolsAllow: ["read"] },
    });

    await expect(
      executeCron(
        {
          action: "update",
          id: "job-no-revision",
          job: { payload: { message: "updated" } },
        },
        { creatorToolAllowlist: ["read", "cron"] },
      ),
    ).rejects.toThrow("cron.get response is missing configRevision");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("uses the stored revision when converting an existing job to agentTurn", async () => {
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-12",
        payload: { kind: "systemEvent", text: "hello" },
      })
      .mockResolvedValueOnce({ ok: true });

    await executeCron(
      {
        action: "update",
        id: "job-12",
        job: {
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "run later" },
        },
      },
      {
        agentSessionKey: "agent:main:telegram:group:restricted-room",
        creatorToolAllowlist: ["read", "cron"],
      },
    );

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expect(readGatewayCall(1)).toEqual({
      method: "cron.update",
      params: {
        id: "job-12",
        expectedConfigRevision: "sha256:test",
        patch: {
          sessionTarget: "isolated",
          payload: {
            kind: "agentTurn",
            message: "run later",
          },
        },
      },
    });
  });

  it.each([undefined, null])(
    "creates a schedule without capturing a per-job tool list (%j)",
    async (toolsAllow) => {
      const resolveCreatorToolAuthority = vi.fn(async () => {
        throw new Error("a schedule must not snapshot current plugin authorization");
      });
      const tool = createTestCronTool({
        agentSessionKey: "agent:main:chat:group:team",
        creatorToolAllowlist: ["automations"],
        resolveCreatorToolAuthority,
      });
      await tool.execute("create-schedule", {
        action: "add",
        job: {
          name: "Read the project notes",
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "Read the project notes", toolsAllow },
          delivery: { mode: "none" },
        },
      });
      const params = expectSingleGatewayCallMethod("cron.add");
      expect(params?.payload).toEqual({ kind: "agentTurn", message: "Read the project notes" });
    },
  );

  it.each(
    ["add", "update"].flatMap((action) =>
      [[], ["read"], ["*"]].map((toolsAllow) => ({ action, toolsAllow })),
    ),
  )(
    "rejects an obsolete tool restriction on $action ($toolsAllow) before writing",
    async ({ action, toolsAllow }) => {
      await expect(
        createTestCronTool().execute("obsolete-cap", {
          action,
          jobId: "job-obsolete-cap",
          job: {
            name: "task",
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            payload: { kind: "agentTurn", message: "run", toolsAllow },
          },
        }),
      ).rejects.toThrow("Per-job tool restrictions are no longer supported");
      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it("does not create a schedule after the tool call is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      createTestCronTool().execute("cancelled-call", { action: "add" }, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
