import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayMock, extractDeliveryInfoMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  extractDeliveryInfoMock: vi.fn(),
}));

vi.mock("../../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: extractDeliveryInfoMock,
}));

import {
  consumeCronCreatorAuthorityGrant,
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "../../gateway/cron-creator-authority-grant.js";
import type { CronCreatorAuthorityGrant } from "../../gateway/cron-creator-authority-grant.types.js";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import {
  bindActiveCronCreatorAuthorityResolver,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityResolver,
} from "../cron-creator-authority-context.js";
import { textAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { createCronTool } from "./cron-tool.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";

type CronToolOptions = NonNullable<Parameters<typeof createCronTool>[0]>;

describe("cron tool", () => {
  function runWithTestCronCreatorAuthority<T>(
    runId: string,
    run: () => T,
    signal?: AbortSignal,
  ): T {
    const capability = createCronCreatorAuthorityCapability(runId);
    if (!capability) {
      throw new Error("expected cron creator authority capability");
    }
    return runWithCronCreatorAuthorityCapability(capability, run, signal);
  }

  type TestDelivery = {
    mode?: string;
    target?: string;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };

  function createTestCronTool(opts?: CronToolOptions) {
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

  function executeCron(args: Record<string, unknown>, opts?: CronToolOptions) {
    return createTestCronTool(opts).execute("cron", args);
  }

  function resolvedCreatorAuthority(
    tools: readonly (string | { name: string; pluginId?: string })[],
    grant: CronCreatorAuthorityGrant = { runId: "run-test", token: "grant-test" },
  ) {
    return {
      tools,
      provenance: { version: 1 as const, source: "final-executable-surface" as const },
      grant,
    };
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
    currentDeliveryContext?: CronToolOptions["currentDeliveryContext"];
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

  it.each([
    { action: "remove", jobId: "job-other" },
    { action: "add", job: buildReminderAgentTurnJob() },
  ])("denies scoped isolated cron runs from using $action outside their job", async (args) => {
    await expect(
      executeCron(args, {
        agentSessionKey: "main",
        selfRemoveOnlyJobId: "job-current",
      }),
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

  it.each([["oversized limit", { limit: 201 }]])(
    "rejects a %s before calling the cron gateway",
    async (_label, pagination) => {
      await expect(executeCron({ action: "list", ...pagination })).rejects.toThrow(
        /(?:limit|offset) must be a (?:positive|non-negative) integer/,
      );

      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  describe("wake routing", () => {
    // Pin the agentId / sessionKey resolution contract for `action: "wake"`.
    // The gateway target resolver treats `agentId` as authoritative, so
    // pairing the caller's inferred agentId with a foreign explicit
    // sessionKey would canonicalize the wake back to the caller agent's
    // main lane.

    it.each([
      {
        name: "infers the calling session and agent",
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
        input: { text: "ping" },
        expected: {
          mode: "now",
          text: "ping",
          sessionKey: "agent:agent-123:telegram:direct:channing",
          agentId: "agent-123",
        },
      },
      {
        name: "preserves contradictory explicit targets for Gateway validation",
        agentSessionKey: undefined,
        input: { text: "manual", sessionKey: "agent:agent-456:discord:thread-xyz", agentId: "ops" },
        expected: {
          mode: "now",
          text: "manual",
          sessionKey: "agent:agent-456:discord:thread-xyz",
          agentId: "ops",
        },
      },
      {
        name: "preserves an unparseable explicit session for Gateway caller binding",
        agentSessionKey: "agent:agent-123:telegram:direct:channing",
        input: { text: "x", sessionKey: "subagent:weird:format" },
        expected: { mode: "now", text: "x", sessionKey: "subagent:weird:format" },
      },
    ])("$name", async ({ agentSessionKey, input, expected }) => {
      await executeCron({ action: "wake", ...input }, { agentSessionKey });
      expect(expectSingleGatewayCallMethod("wake")).toEqual(expected);
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

  it.each([
    {
      name: "blank declaration key",
      args: { action: "add", job: { ...buildReminderAgentTurnJob(), declarationKey: "   " } },
      error: "declarationKey must be a non-empty string",
    },
    {
      name: "blank create display name",
      args: {
        action: "add",
        job: { ...buildReminderAgentTurnJob(), declarationKey: "daily", displayName: "   " },
      },
      error: "displayName must be a non-empty string",
    },
    {
      name: "blank patch display name",
      args: { action: "update", jobId: "daily", job: { displayName: "   " } },
      error: "displayName must be a non-empty string or null",
    },
    {
      name: "empty patch pacing",
      args: { action: "update", jobId: "paced-job", job: { pacing: {} } },
      error: "cron pacing requires at least one of min or max",
    },
  ])("rejects $name before Gateway normalization", async ({ args, error }) => {
    await expect(executeCron(args)).rejects.toThrow(error);
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

  it.each([
    {
      action: "add",
      job: {
        name: "command",
        schedule: { at: new Date(123).toISOString() },
        sessionTarget: "isolated",
        payload: { kind: "Command", argv: ["sh", "-lc", "echo ok"] },
      },
    },
    {
      action: "update",
      id: "job-4",
      job: { payload: { kind: "Command", argv: ["sh", "-lc", "echo ok"] } },
    },
  ])("rejects mixed-case command payloads on $action", async (args) => {
    await expect(executeCron(args)).rejects.toThrow(
      "automation command payloads cannot be created or edited",
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("does not write when the admitted run aborts while lazy authority resolves", async () => {
    let finishResolution!: () => void;
    const resolution = new Promise<void>((resolve) => {
      finishResolution = resolve;
    });
    const abortController = new AbortController();
    const run = runWithTestCronCreatorAuthority(
      "run-timeout",
      () => {
        const resolveCreatorToolAuthority = runWithCronCreatorAuthorityResolver({
          runId: "run-timeout",
          resolve: async () => {
            await resolution;
            return {
              tools: ["read", "configured__lookup"],
              provenance: { version: 1, source: "final-executable-surface" },
            };
          },
          run: () => bindActiveCronCreatorAuthorityResolver("run-timeout"),
        });

        return executeCron(
          {
            action: "add",
            job: buildReminderAgentTurnJob(),
          },
          {
            agentSessionKey: "agent:main:main",
            resolveCreatorToolAuthority,
          },
        );
      },
      abortController.signal,
    );

    abortController.abort(new Error("run timed out"));
    finishResolution();
    await expect(run).rejects.toThrow();
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("lets a later cron operation rematerialize after an earlier operation abort", async () => {
    let finishFirstResolution!: () => void;
    const firstResolution = new Promise<void>((resolve) => {
      finishFirstResolution = resolve;
    });
    let materializations = 0;
    let discoverySignal: AbortSignal | undefined;
    callGatewayMock.mockImplementation(async () => {
      const grant = getGatewayToolCallerIdentity()?.cronCreatorAuthorityGrant;
      expect(grant).toBeDefined();
      consumeCronCreatorAuthorityGrant(grant!);
      return { ok: true };
    });

    await runWithTestCronCreatorAuthority("run-operation-retry", async () => {
      const resolveCreatorToolAuthority = runWithCronCreatorAuthorityResolver({
        runId: "run-operation-retry",
        resolve: async (options) => {
          discoverySignal = options?.signal;
          materializations += 1;
          if (materializations === 1) {
            await firstResolution;
          }
          return {
            tools: ["read", "configured__lookup"],
            provenance: { version: 1, source: "final-executable-surface" },
          };
        },
        run: () => bindActiveCronCreatorAuthorityResolver("run-operation-retry"),
      });
      const tool = createTestCronTool({
        agentSessionKey: "agent:main:main",
        resolveCreatorToolAuthority,
      });
      const firstOperation = new AbortController();
      const firstWrite = tool.execute(
        "call-operation-retry-first",
        { action: "add", job: buildReminderAgentTurnJob() },
        firstOperation.signal,
      );
      firstOperation.abort(new Error("first cron call timed out"));
      finishFirstResolution();
      await expect(firstWrite).rejects.toThrow("first cron call timed out");
      expect(discoverySignal?.aborted).toBe(true);
      expect(callGatewayMock).not.toHaveBeenCalled();

      await tool.execute(
        "call-operation-retry-second",
        { action: "add", job: buildReminderAgentTurnJob() },
        new AbortController().signal,
      );
    });

    expect(materializations).toBe(2);
    expect(callGatewayMock).toHaveBeenCalledOnce();
    expect(readGatewayCall().params).toMatchObject({
      payload: { toolsAllow: ["*"] },
    });
  });

  it("does not commit when the exact cron tool call aborts after grant mint", async () => {
    const operation = new AbortController();
    let committedWrites = 0;
    callGatewayMock.mockImplementation(async () => {
      const grant = getGatewayToolCallerIdentity()?.cronCreatorAuthorityGrant;
      expect(grant).toBeDefined();
      operation.abort(new Error("cron tool call timed out before commit"));
      consumeCronCreatorAuthorityGrant(grant!);
      committedWrites += 1;
      return { ok: true };
    });
    const run = runWithTestCronCreatorAuthority("run-abort-before-commit", () => {
      const resolveCreatorToolAuthority = runWithCronCreatorAuthorityResolver({
        runId: "run-abort-before-commit",
        resolve: async () => ({
          tools: ["read", "configured__lookup"],
          provenance: { version: 1, source: "final-executable-surface" },
        }),
        run: () => bindActiveCronCreatorAuthorityResolver("run-abort-before-commit"),
      });
      const tool = createTestCronTool({
        agentSessionKey: "agent:main:main",
        resolveCreatorToolAuthority,
      });
      return tool.execute(
        "call-abort-before-commit",
        { action: "add", job: buildReminderAgentTurnJob() },
        operation.signal,
      );
    });

    await expect(run).rejects.toThrow("Configured MCP cron authority is no longer active");
    expect(committedWrites).toBe(0);
  });

  it("fails a queued configured-MCP default add visibly without writing", async () => {
    await expect(
      executeCron(
        {
          action: "add",
          job: buildReminderAgentTurnJob(),
        },
        {
          agentSessionKey: "agent:main:main",
          creatorToolAllowlist: ["read", "cron"],
          creatorAuthorityUnavailableReason: "queued-local-operator-configured-mcp",
        },
      ),
    ).rejects.toThrow("fresh authenticated direct-local operator turn");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([["empty", []]])(
    "keeps an explicit %s add offline and exact",
    async (_label, toolsAllow) => {
      const resolveCreatorToolAuthority = vi.fn(async () => {
        throw new Error("must stay offline");
      });

      await executeCron(
        {
          action: "add",
          job: {
            ...buildReminderAgentTurnJob(),
            payload: { kind: "agentTurn", message: "hello", toolsAllow },
          },
        },
        {
          agentSessionKey: "agent:main:main",
          creatorToolAllowlist: ["read", "cron"],
          resolveCreatorToolAuthority,
        },
      );

      expect(resolveCreatorToolAuthority).not.toHaveBeenCalled();
      expect(readGatewayCall().params).toMatchObject({ payload: { toolsAllow } });
    },
  );

  it.each([
    {
      name: "unknown finite names cannot pre-authorize a future tool",
      toolsAllow: ["future__tool"],
      creatorToolAllowlist: ["read"],
      resolved: ["read"],
      expected: [],
    },
    {
      name: "symbolic groups resolve before persisting the cap",
      toolsAllow: ["group:plugins"],
      creatorToolAllowlist: undefined,
      resolved: ["read", { name: "configured__lookup", pluginId: "bundle-mcp" }],
      expected: ["configured__lookup"],
    },
  ])("$name", async ({ toolsAllow, creatorToolAllowlist, resolved, expected }) => {
    const resolveCreatorToolAuthority = vi.fn(async () => resolvedCreatorAuthority(resolved));
    await executeCron(
      {
        action: "add",
        job: {
          ...buildReminderAgentTurnJob(),
          payload: { kind: "agentTurn", message: "hello", toolsAllow },
        },
      },
      { agentSessionKey: "agent:main:main", creatorToolAllowlist, resolveCreatorToolAuthority },
    );
    expect(resolveCreatorToolAuthority).toHaveBeenCalledOnce();
    expect(readGatewayCall().params).toMatchObject({ payload: { toolsAllow: expected } });
  });

  it("does not write a default add when configured MCP authentication fails", async () => {
    await expect(
      executeCron(
        {
          action: "add",
          job: buildReminderAgentTurnJob(),
        },
        {
          agentSessionKey: "agent:main:main",
          resolveCreatorToolAuthority: async () => {
            throw new Error(
              "Sign in to configured MCP, then retry; no automation changes were saved.",
            );
          },
        },
      ),
    ).rejects.toThrow("no automation changes were saved");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("fails incomplete inherited and unknown finite adds while preserving known finite tools", async () => {
    const captureRef = {};
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:telegram:group:restricted-room",
      creatorToolAllowlist: ["read", "cron"],
      creatorToolAllowlistCaptureRef: captureRef,
    });

    await expect(
      tool.execute("call-default-capture-unavailable", {
        action: "add",
        job: buildReminderAgentTurnJob(),
      }),
    ).rejects.toThrow("fresh authenticated direct-local operator turn");
    expect(callGatewayMock).not.toHaveBeenCalled();

    await expect(
      tool.execute("call-unknown-finite-capture-unavailable", {
        action: "add",
        job: {
          ...buildReminderAgentTurnJob(),
          payload: {
            kind: "agentTurn",
            message: "hello",
            toolsAllow: ["future__tool"],
          },
        },
      }),
    ).rejects.toThrow("CLI or Gateway with an explicit finite toolsAllow list");
    expect(callGatewayMock).not.toHaveBeenCalled();

    await tool.execute("call-explicit-capture-unavailable", {
      action: "add",
      job: {
        ...buildReminderAgentTurnJob(),
        payload: { kind: "agentTurn", message: "hello", toolsAllow: ["read"] },
      },
    });
    expect(expectSingleGatewayCallMethod("cron.add")).toMatchObject({
      payload: { toolsAllow: ["read"] },
    });
  });

  it("caps trigger-script systemEvent updates to the creator tool surface", async () => {
    callGatewayMock.mockResolvedValueOnce({
      id: "job-trigger",
      payload: { kind: "systemEvent", text: "changed" },
    });

    await executeCron(
      {
        action: "update",
        id: "job-trigger",
        job: { trigger: { script: "return { fire: false }" } },
      },
      {
        agentSessionKey: "agent:main:telegram:group:restricted-room",
        creatorToolAllowlist: ["read", "cron"],
      },
    );

    expect(readGatewayCall(1)).toEqual({
      method: "cron.update",
      params: {
        id: "job-trigger",
        expectedConfigRevision: "sha256:test",
        patch: {
          trigger: { script: "return { fire: false }" },
          payload: {
            kind: "systemEvent",
            toolsAllow: ["read", "automations"],
            toolsAllowIsDefault: true,
          },
        },
      },
    });
  });

  it("caps dormant systemEvent toolsAllow updates without relying on trigger state", async () => {
    await executeCron(
      {
        action: "update",
        id: "job-dormant",
        job: {
          payload: { kind: "systemEvent", toolsAllow: ["read", "exec"] },
        },
      },
      {
        agentSessionKey: "agent:main:telegram:group:restricted-room",
        creatorToolAllowlist: ["read", "cron"],
      },
    );

    expect(readGatewayCall()).toEqual({
      method: "cron.update",
      params: {
        id: "job-dormant",
        patch: { payload: { kind: "systemEvent", toolsAllow: ["read"] } },
      },
    });
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

  it("does not stamp caller sessionKey when add targets isolated session", async () => {
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
    callGatewayMock.mockResolvedValueOnce({ messages });

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

  it.each([
    {
      name: "explicit delivery target wins",
      agentSessionKey: "agent:main:matrix:channel:!abcdef1234567890:example.org",
      currentDeliveryContext: { channel: "matrix", to: "room:!AbCdEf1234567890:example.org" },
      delivery: { mode: "announce", channel: "telegram", to: "-100123" },
      expected: { mode: "announce", channel: "telegram", to: "-100123" },
    },
    {
      name: "context supplies delivery without a session key",
      currentDeliveryContext: { channel: "matrix", to: "!AbCdEf1234567890:example.org" },
      expected: { mode: "announce", channel: "matrix", to: "!AbCdEf1234567890:example.org" },
    },
    {
      name: "owner delivery does not inherit the current group route",
      agentSessionKey: "agent:main:telegram:group:-100123",
      currentDeliveryContext: { channel: "telegram", to: "-100123" },
      delivery: { mode: "announce", target: "owner" },
      expected: { mode: "announce", target: "owner" },
    },
    {
      name: "webhook does not infer announce delivery",
      agentSessionKey: "agent:main:discord:dm:buddy",
      delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      expected: { mode: "webhook", to: "https://example.invalid/cron-finished" },
    },
  ])("$name", async ({ name, expected, ...params }) => {
    expect(await executeAddAndReadDelivery({ callId: name, ...params })).toEqual(expected);
  });

  it("recovers flat text and toolsAllow as a systemEvent payload", async () => {
    await executeCron({
      action: "add",
      name: "flat-system-event",
      schedule: { kind: "every", everyMs: 60_000 },
      text: "tick",
      toolsAllow: [" read ", " cron "],
    });

    const params = expectSingleGatewayCallMethod("cron.add");
    expect(params).toHaveProperty("payload", {
      kind: "systemEvent",
      text: "tick",
      toolsAllow: ["read", "cron"],
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

  it("uses flat string scheduleKind without leaking it to cron update", async () => {
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

  it("restores the wildcard cap when an agentTurn update clears toolsAllow", async () => {
    callGatewayMock.mockResolvedValueOnce({
      id: "job-8",
      payload: { kind: "agentTurn", message: "before" },
    });

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
      toolsAllow: ["*"],
    });
  });

  it("reuses one resolved snapshot across a conflicting wildcard reauthorization", async () => {
    const conflict = Object.assign(new Error("changed"), {
      name: "GatewayClientRequestError",
      details: { code: "CRON_JOB_CHANGED" },
    });
    const writeIdentities: unknown[] = [];
    const authorityScope = createCronCreatorAuthorityRunScope("run-update-race");
    const operation = new AbortController();
    const authorityGrant = mintCronCreatorAuthorityGrant(authorityScope, operation.signal);
    callGatewayMock
      .mockResolvedValueOnce({
        id: "job-resolve-race",
        configRevision: "sha256:first",
        payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
      })
      .mockImplementationOnce(async () => {
        writeIdentities.push(getGatewayToolCallerIdentity());
        throw conflict;
      })
      .mockResolvedValueOnce({
        id: "job-resolve-race",
        configRevision: "sha256:second",
        payload: { kind: "agentTurn", message: "before", toolsAllow: [] },
      })
      .mockImplementationOnce(async () => {
        const identity = getGatewayToolCallerIdentity();
        writeIdentities.push(identity);
        consumeCronCreatorAuthorityGrant(identity!.cronCreatorAuthorityGrant!);
        return { ok: true };
      });
    const resolveCreatorToolAuthority = vi.fn(async () =>
      resolvedCreatorAuthority(["read", "configured__lookup"], authorityGrant),
    );
    const tool = createTestCronTool({
      agentSessionKey: "agent:main:main",
      resolveCreatorToolAuthority,
    });

    await tool.execute(
      "call-update-resolve-race",
      {
        action: "update",
        id: "job-resolve-race",
        job: { payload: { toolsAllow: ["*"] } },
      },
      operation.signal,
    );

    expect(resolveCreatorToolAuthority).toHaveBeenCalledOnce();
    expect(readGatewayCall(1).params).toMatchObject({
      patch: {
        payload: {
          kind: "agentTurn",
          toolsAllow: ["*"],
        },
      },
    });
    expect(readGatewayCall(3).params).toMatchObject({
      expectedConfigRevision: "sha256:second",
      patch: {
        payload: {
          kind: "agentTurn",
          toolsAllow: ["*"],
        },
      },
    });
    expect(writeIdentities).toEqual([
      expect.objectContaining({
        cronToolsAllowCapture: "final-executable-surface",
        cronCreatorAuthorityGrant: authorityGrant,
      }),
      expect.objectContaining({
        cronToolsAllowCapture: "final-executable-surface",
        cronCreatorAuthorityGrant: authorityGrant,
      }),
    ]);
    expect(() => consumeCronCreatorAuthorityGrant(authorityGrant)).toThrow(
      "Configured MCP cron authority is no longer active",
    );
    revokeCronCreatorAuthorityRunScope(authorityScope);
  });

  it.each<{
    name: string;
    id: string;
    current: Record<string, unknown>;
    payload: Record<string, unknown>;
    options: CronToolOptions;
    error: string;
  }>([
    {
      name: "fresh authority requires authenticated grant transport",
      id: "job-no-caller-identity",
      current: {
        configRevision: "sha256:no-caller-identity",
        payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
      },
      payload: { toolsAllow: ["*"] },
      options: {
        resolveCreatorToolAuthority: async () =>
          resolvedCreatorAuthority(["read", "configured__lookup"]),
      },
      error: "requires an authenticated local agent run",
    },
    {
      name: "unknown finite tools require complete configured-MCP capture",
      id: "job-incomplete-authority",
      current: {
        configRevision: "sha256:incomplete-authority",
        payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
      },
      payload: { kind: "agentTurn", toolsAllow: ["future__tool"] },
      options: {
        agentSessionKey: "agent:main:telegram:group:restricted-room",
        creatorToolAllowlist: ["read", "cron"],
        creatorToolAllowlistCaptureRef: {},
      },
      error: "fresh authenticated direct-local operator turn",
    },
    {
      name: "updates require a current config revision",
      id: "job-no-revision",
      current: {
        configRevision: null,
        payload: { kind: "agentTurn", message: "hello", toolsAllow: ["read"] },
      },
      payload: { message: "updated" },
      options: { creatorToolAllowlist: ["read", "cron"] },
      error: "cron.get response is missing configRevision",
    },
  ])("$name", async ({ id, current, payload, options, error }) => {
    callGatewayMock.mockResolvedValueOnce({ id, ...current });
    await expect(executeCron({ action: "update", id, job: { payload } }, options)).rejects.toThrow(
      error,
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(readGatewayCall()).toEqual({ method: "cron.get", params: { id } });
  });

  it("adds a wildcard cap when converting an existing job to agentTurn", async () => {
    callGatewayMock.mockResolvedValueOnce({
      id: "job-12",
      payload: { kind: "systemEvent", text: "hello" },
    });

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
            toolsAllow: ["*"],
          },
        },
      },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
