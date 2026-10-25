import { expect, it, vi } from "vitest";
import {
  consumeCronCreatorAuthorityGrant,
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "../../gateway/cron-creator-authority-grant.js";
import type { CronCreatorAuthorityGrant } from "../../gateway/cron-creator-authority-grant.types.js";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  bindActiveCronCreatorAuthorityResolver,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityResolver,
} from "../cron-creator-authority-context.js";
import { textAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { createCronTool } from "./cron-tool.js";
import {
  callGatewayMock,
  createTestCronTool,
  executeCron,
  installCronToolTestFixture,
  readGatewayCall,
} from "./cron-tool.test-support.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";

type Options = Parameters<typeof createCronTool>[0];
const ok = { ok: true };
const mainCaller = { agentSessionKey: "agent:main:main" };
const scopedCaller = { agentSessionKey: "main", selfRemoveOnlyJobId: "job-current" };
const channelCaller = { agentSessionKey: "agent:agent-123:telegram:direct:channing" };
const scopedError = "Automations tool is restricted to the current automation.";
const commandError = "automation command payloads cannot be created or edited";
const materializedTools = {
  tools: ["read", "configured__lookup"],
  provenance: { version: 1 as const, source: "final-executable-surface" as const },
};
type TestDelivery = Partial<Record<"mode" | "channel" | "to", string>>;

function resolvedCreatorAuthority(
  tools: readonly (string | { name: string; pluginId?: string })[],
  grant: CronCreatorAuthorityGrant = { runId: "run-test", token: "grant-test" },
) {
  return { ...materializedTools, tools, grant };
}

function mockCaller(result: unknown = ok) {
  let identity: ReturnType<typeof getGatewayToolCallerIdentity>;
  callGatewayMock.mockImplementation(async () => {
    identity = getGatewayToolCallerIdentity();
    return result;
  });
  return () => identity;
}

function expectSingleCall(method: string) {
  expect(callGatewayMock).toHaveBeenCalledTimes(1);
  const call = readGatewayCall(0);
  expect(call.method).toBe(method);
  return call.params;
}

function agentTurn(fields: Record<string, unknown> = {}) {
  return { kind: "agentTurn" as const, message: "hello", ...fields };
}

function storedAgentTurn(configRevision: string | null, toolsAllow = ["read"], message = "before") {
  return { configRevision, payload: agentTurn({ message, toolsAllow }) };
}

function reminder(fields: Record<string, unknown> = {}) {
  return {
    name: "reminder",
    schedule: { at: new Date(123).toISOString() },
    payload: agentTurn(),
    ...fields,
  };
}

function addJob(fields: Record<string, unknown> = {}) {
  return { action: "add", job: reminder(fields) };
}

function updateJob(id: string, job: Record<string, unknown>) {
  return { action: "update", id, job };
}

const restrictedCaller = {
  agentSessionKey: "agent:main:telegram:group:restricted-room",
  creatorToolAllowlist: ["read", "cron"],
};

function authorizedTool(
  resolveCreatorToolAuthority: NonNullable<Options>["resolveCreatorToolAuthority"],
) {
  return createTestCronTool({ ...mainCaller, resolveCreatorToolAuthority });
}

function withAuthorizedTool<T>(
  runId: string,
  resolve: Parameters<typeof runWithCronCreatorAuthorityResolver>[0]["resolve"],
  run: (tool: ReturnType<typeof createCronTool>) => T,
  signal?: AbortSignal,
) {
  const capability = createCronCreatorAuthorityCapability(runId);
  if (!capability) {
    throw new Error("expected cron creator authority capability");
  }
  return runWithCronCreatorAuthorityCapability(
    capability,
    () =>
      runWithCronCreatorAuthorityResolver({
        runId,
        resolve,
        run: () => run(authorizedTool(bindActiveCronCreatorAuthorityResolver(runId))),
      }),
    signal,
  );
}

async function executeAddAndReadDelivery({
  delivery,
  ...options
}: NonNullable<Options> & {
  delivery?: TestDelivery | null;
}) {
  await executeCron(addJob(delivery !== undefined ? { delivery } : {}), options);
  return (readGatewayCall().params as { delivery?: TestDelivery } | undefined)?.delivery;
}

installCronToolTestFixture();

it("allows scoped isolated cron runs to remove the current job", async () => {
  await executeCron({ action: "remove", jobId: "job-current" }, scopedCaller);
  expect(expectSingleCall("cron.remove")).toEqual({ id: "job-current" });
});

it("redacts global status while preserving authenticated caller identity", async () => {
  const identity = mockCaller({
    enabled: true,
    jobs: 37,
    storePath: "/synthetic/state.sqlite",
    nextWakeAtMs: 1234,
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
  expect(expectSingleCall("cron.status")).toEqual({});
  expect(result.details).toEqual({ enabled: true });
  expect(callGatewayMock.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 5000 });
  expect(identity()).toMatchObject({
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
    { action: "list", includeDisabled: true, limit: 1, offset: 200 },
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
    jobs: [currentJob],
    total: 1,
    offset: 0,
    limit: 1,
    hasMore: false,
    nextOffset: null,
    deliveryPreviews: { "job-current": { label: "current", detail: "self" } },
    includeDisabled: true,
    inventoryHint: expect.stringContaining("Absence does not prove deletion"),
  });
});

it.each([
  {
    name: "authenticated caller without an agent filter",
    options: channelCaller,
    input: {},
    expected: { includeDisabled: false, compact: true },
  },
  {
    name: "sessionless caller with explicit agent and pagination",
    options: undefined,
    input: { agentId: "worker", includeDisabled: true, limit: 200, offset: 200 },
    expected: {
      includeDisabled: true,
      compact: true,
      agentId: "worker",
      limit: 200,
      offset: 200,
    },
  },
])("lists for $name", async ({ options, input, expected }) => {
  const identity = mockCaller({ jobs: [] });
  await executeCron({ action: "list", ...input }, options);
  expect(expectSingleCall("cron.list")).toEqual(expected);
  if (options) {
    expect(identity()).toMatchObject({ agentId: "agent-123", sessionKey: options.agentSessionKey });
  }
});

it.each([
  {
    name: "infers the calling session and agent",
    ...channelCaller,
    input: { text: "ping", mode: "now" },
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
      mode: "next-heartbeat",
      text: "manual",
      sessionKey: "agent:agent-456:discord:thread-xyz",
      agentId: "ops",
    },
  },
  {
    name: "preserves an unparseable explicit session for Gateway caller binding",
    ...channelCaller,
    input: { text: "x", sessionKey: "subagent:weird:format" },
    expected: { mode: "next-heartbeat", text: "x", sessionKey: "subagent:weird:format" },
  },
])("$name", async ({ agentSessionKey, input, expected }) => {
  await executeCron({ action: "wake", ...input }, { agentSessionKey });
  expect(expectSingleCall("wake")).toEqual(expected);
});

it("preserves scoped lookup recovery guidance with triggers enabled", () => {
  const tool = createTestCronTool({ config: { cron: { triggers: { enabled: true } } } });
  expect(tool.description).toContain(
    "an empty list or failed list/get/update/remove (including not-found) does not establish global absence",
  );
  expect(tool.description).toContain("Never recreate or replace a known automation");
  expect(tool.description).toContain("ask an authorized administrator");
});

it("describes conversation workspace inheritance for current jobs", () => {
  const { description } = createTestCronTool();
  expect(description).toContain(
    "works at this conversation's saved workspace root with its sandbox",
  );
  expect(description).not.toContain(
    "uses the scheduled agent workspace with its own session identity",
  );
});

it.each([
  { timeoutMs: undefined, waitTimeoutMs: 60_000 },
  { timeoutMs: 3_600_000, waitTimeoutMs: 600_000 },
])(
  "prefers jobId and bounds the run wait at $waitTimeoutMs",
  async ({ timeoutMs, waitTimeoutMs }) => {
    if (timeoutMs !== undefined) {
      callGatewayMock.mockResolvedValueOnce({ ok: true, enqueued: true, runId: "manual:job:1" });
    }
    const result = await executeCron({
      action: "run",
      jobId: "job-primary",
      id: "job-legacy",
      runMode: "force",
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    expect(readGatewayCall().params).toEqual({ id: "job-primary", mode: "force", waitTimeoutMs });
    if (timeoutMs !== undefined) {
      expect(callGatewayMock.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 660_000 });
      expect(result.details).toMatchObject({
        runId: "manual:job:1",
        note: expect.stringContaining("runs jobId runId"),
      });
    }
  },
);

it.each([
  {
    name: "wrapped payload",
    input: {
      job: {
        data: {
          name: "wake-up",
          schedule: { atMs: 123 },
          payload: { kind: "systemEvent", text: "hello" },
        },
      },
    },
    expected: {
      name: "wake-up",
      enabled: true,
      deleteAfterRun: true,
      schedule: { kind: "at", at: new Date(123).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    },
  },
  {
    name: "flat concatenated local-parser keys",
    input: {
      delivery: { mode: "none" },
      enabled: true,
      namePayload: { kind: "agentTurn", message: "Evidence test.", timeoutSeconds: 10 },
      scheduleKind: { everyMs: 999_999, kind: "every" },
      sessionTargetName: "evidence-test",
    },
    expected: {
      delivery: { mode: "none" },
      enabled: true,
      name: "evidence-test",
      payload: { kind: "agentTurn", message: "Evidence test.", timeoutSeconds: 10 },
      schedule: { everyMs: 999_999, kind: "every" },
      sessionTarget: "isolated",
      wakeMode: "now",
    },
  },
])("normalizes cron.add $name", async ({ input, expected }) => {
  await executeCron({ action: "add", ...input });
  expect(expectSingleCall("cron.add")).toEqual(expected);
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

it.each<[string, Record<string, unknown>, (string | RegExp)?, Options?]>([
  ["scoped remove", { action: "remove", jobId: "job-other" }, scopedError, scopedCaller],
  ["scoped add", addJob(), scopedError, scopedCaller],
  [
    "oversized list limit",
    { action: "list", limit: 201 },
    /(?:limit|offset) must be a (?:positive|non-negative) integer/,
  ],
  ["wake without text", { action: "wake" }, undefined, channelCaller],
  [
    "blank declaration key",
    addJob({ declarationKey: "   " }),
    "declarationKey must be a non-empty string",
  ],
  [
    "blank create display name",
    addJob({ declarationKey: "daily", displayName: "   " }),
    "displayName must be a non-empty string",
  ],
  [
    "blank patch display name",
    { action: "update", jobId: "daily", job: { displayName: "   " } },
    "displayName must be a non-empty string or null",
  ],
  [
    "empty patch pacing",
    { action: "update", jobId: "paced-job", job: { pacing: {} } },
    "cron pacing requires at least one of min or max",
  ],
  [
    "mixed-case command add",
    addJob({
      name: "command",
      sessionTarget: "isolated",
      payload: { kind: "Command", argv: ["sh", "-lc", "echo ok"] },
    }),
    commandError,
  ],
  [
    "mixed-case command update",
    updateJob("job-4", { payload: { kind: "Command", argv: ["sh", "-lc", "echo ok"] } }),
    commandError,
  ],
  [
    "invalid contextMessages",
    {
      ...addJob({ payload: { kind: "systemEvent", text: "Reminder: the thing." } }),
      contextMessages: "2messages",
    },
    "contextMessages must be a non-negative integer",
    { agentSessionKey: "main" },
  ],
  [
    "flat add without meaningful job fields",
    { action: "add", name: "orphan-name", enabled: true },
    "job required",
  ],
  [
    "malformed flattened fallback-only update",
    { action: "update", id: "job-9", fallbacks: [123] },
    "job required",
  ],
  [
    "non-http webhook URL",
    addJob({ delivery: { mode: "webhook", to: "ftp://example.invalid/cron-finished" } }),
    'delivery.mode="webhook" requires delivery.to to be a valid http(s) URL',
    { agentSessionKey: "agent:main:discord:dm:buddy" },
  ],
])("rejects %s before calling the Gateway", async (_name, args, error, options) => {
  await expect(executeCron(args, options)).rejects.toThrow(error);
  expect(callGatewayMock).not.toHaveBeenCalled();
});

it("forwards null add ownership separately from authenticated caller identity", async () => {
  const identity = mockCaller();
  await executeCron(addJob({ agentId: null }), channelCaller);
  expect(expectSingleCall("cron.add")?.agentId).toBeNull();
  expect(identity()).toMatchObject({
    agentId: "agent-123",
    sessionKey: "agent:agent-123:telegram:direct:channing",
  });
});

it("does not forward model-supplied callerScope", async () => {
  callGatewayMock.mockResolvedValueOnce(storedAgentTurn("sha256:test"));
  await executeCron(
    { action: "remove", jobId: "job-1", callerScope: { kind: "agentTool", agentId: "worker" } },
    channelCaller,
  );
  expect(callGatewayMock.mock.calls.map(([call]) => call)).toEqual([
    { method: "cron.get", params: { id: "job-1" } },
    {
      method: "cron.remove",
      params: { id: "job-1", expectedConfigRevision: "sha256:test" },
    },
  ]);
});

it("does not write when the admitted run aborts while lazy authority resolves", async () => {
  const resolution = createDeferredCore();
  const abortController = new AbortController();
  const run = withAuthorizedTool(
    "run-timeout",
    async () => {
      await resolution.promise;
      return materializedTools;
    },
    (tool) => tool.execute("cron", addJob()),
    abortController.signal,
  );
  abortController.abort(new Error("run timed out"));
  resolution.resolve();
  await expect(run).rejects.toThrow();
  expect(callGatewayMock).not.toHaveBeenCalled();
});

it("lets a later cron operation rematerialize after an earlier operation abort", async () => {
  const firstResolution = createDeferredCore();
  const discoveryStarted = createDeferredCore();
  let materializations = 0;
  let discoverySignal: AbortSignal | undefined;
  callGatewayMock.mockImplementation(async () => {
    const grant = getGatewayToolCallerIdentity()?.cronCreatorAuthorityGrant;
    expect(grant).toBeDefined();
    consumeCronCreatorAuthorityGrant(grant!);
    return ok;
  });
  await withAuthorizedTool(
    "run-operation-retry",
    async (options) => {
      discoverySignal = options?.signal;
      discoveryStarted.resolve();
      materializations += 1;
      if (materializations === 1) {
        await firstResolution.promise;
      }
      return materializedTools;
    },
    async (tool) => {
      const firstOperation = new AbortController();
      const firstWrite = tool.execute(
        "call-operation-retry-first",
        addJob(),
        firstOperation.signal,
      );
      await discoveryStarted.promise;
      firstOperation.abort(new Error("first cron call timed out"));
      firstResolution.resolve();
      await expect(firstWrite).rejects.toThrow("first cron call timed out");
      expect(discoverySignal?.aborted).toBe(true);
      expect(callGatewayMock).not.toHaveBeenCalled();
      await tool.execute("call-operation-retry-second", addJob(), new AbortController().signal);
    },
  );
  expect(materializations).toBe(2);
  expect(callGatewayMock).toHaveBeenCalledOnce();
  expect(readGatewayCall().params).toMatchObject({ payload: { toolsAllow: ["*"] } });
  expect(readGatewayCall().params?.payload).not.toHaveProperty("toolsAllowIsDefault");
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
    return ok;
  });
  const run = withAuthorizedTool(
    "run-abort-before-commit",
    async () => materializedTools,
    (tool) => tool.execute("call-abort-before-commit", addJob(), operation.signal),
  );
  await expect(run).rejects.toThrow("Configured MCP cron authority is no longer active");
  expect(committedWrites).toBe(0);
});

it.each([
  {
    name: "queued configured-MCP authority is unavailable",
    options: {
      creatorToolAllowlist: ["read", "cron"],
      creatorAuthorityUnavailableReason: "queued-local-operator-configured-mcp" as const,
    },
    error: "fresh authenticated direct-local operator turn",
  },
  {
    name: "configured MCP authentication fails",
    options: {
      resolveCreatorToolAuthority: async () => {
        throw new Error("Sign in to configured MCP, then retry; no automation changes were saved.");
      },
    },
    error: "no automation changes were saved",
  },
])("does not write a default add when $name", async ({ options, error }) => {
  await expect(
    executeCron(addJob(), { agentSessionKey: "agent:main:main", ...options }),
  ).rejects.toThrow(error);
  expect(callGatewayMock).not.toHaveBeenCalled();
});

it("keeps an explicit empty add offline and exact", async () => {
  const resolveCreatorToolAuthority = vi.fn(async () => {
    throw new Error("must stay offline");
  });
  await executeCron(addJob({ payload: agentTurn({ toolsAllow: [] }) }), {
    agentSessionKey: "agent:main:main",
    creatorToolAllowlist: ["read", "cron"],
    resolveCreatorToolAuthority,
  });
  expect(resolveCreatorToolAuthority).not.toHaveBeenCalled();
  expect(readGatewayCall().params).toMatchObject({ payload: { toolsAllow: [] } });
});

it.each([false, true])(
  "rejects uncaptured Codex app tools before saving a partial cap (deferred capture=%s)",
  async (deferred) => {
    const resolveCreatorToolAuthority = deferred
      ? vi.fn(async () => ({
          ...resolvedCreatorAuthority(["message"]),
          holdsRuntimeAuthority: true as const,
        }))
      : undefined;
    await expect(
      executeCron(
        addJob({ payload: agentTurn({ toolsAllow: ["message", "codex_apps.notion.fetch"] }) }),
        {
          agentSessionKey: "agent:main:main",
          creatorToolAllowlist: ["message"],
          resolveCreatorToolAuthority,
        },
      ),
    ).rejects.toThrow('Requested automation tool "codex_apps.notion.fetch" cannot be carried');
    if (resolveCreatorToolAuthority) {
      expect(resolveCreatorToolAuthority).toHaveBeenCalledOnce();
    }
    expect(callGatewayMock).not.toHaveBeenCalled();
  },
);

it("resolves symbolic groups before persisting the cap", async () => {
  const resolveCreatorToolAuthority = vi.fn(async () =>
    resolvedCreatorAuthority(["read", { name: "configured__lookup", pluginId: "bundle-mcp" }]),
  );
  await executeCron(addJob({ payload: agentTurn({ toolsAllow: ["group:plugins", "group:fs"] }) }), {
    agentSessionKey: "agent:main:main",
    resolveCreatorToolAuthority,
  });
  expect(resolveCreatorToolAuthority).toHaveBeenCalledOnce();
  expect(readGatewayCall().params).toMatchObject({
    payload: { toolsAllow: ["read", "configured__lookup"] },
  });
});

it("fails incomplete inherited and unknown finite adds while preserving known finite tools", async () => {
  const captureRef = {};
  const tool = createTestCronTool({
    ...restrictedCaller,
    creatorToolAllowlistCaptureRef: captureRef,
  });
  await expect(tool.execute("call-default-capture-unavailable", addJob())).rejects.toThrow(
    "fresh authenticated direct-local operator turn",
  );
  expect(callGatewayMock).not.toHaveBeenCalled();
  await expect(
    tool.execute(
      "call-unknown-finite-capture-unavailable",
      addJob({ payload: agentTurn({ toolsAllow: ["future__tool"] }) }),
    ),
  ).rejects.toThrow("CLI or Gateway with an explicit finite toolsAllow list");
  expect(callGatewayMock).not.toHaveBeenCalled();
  await tool.execute(
    "call-explicit-capture-unavailable",
    addJob({ payload: agentTurn({ toolsAllow: ["read"] }) }),
  );
  expect(expectSingleCall("cron.add")).toMatchObject({
    payload: { toolsAllow: ["read"] },
  });
});

it("caps a systemEvent trigger-script update to the creator tool surface", async () => {
  callGatewayMock.mockResolvedValueOnce({
    id: "job-trigger",
    payload: { kind: "systemEvent", text: "changed" },
  });
  const trigger = { script: "return { fire: false }" };
  await executeCron(updateJob("job-trigger", { trigger }), restrictedCaller);
  expect(readGatewayCall(1)).toEqual({
    method: "cron.update",
    params: {
      id: "job-trigger",
      expectedConfigRevision: "sha256:test",
      patch: {
        trigger,
        payload: {
          kind: "systemEvent",
          toolsAllow: ["read", "automations"],
          toolsAllowIsDefault: true,
        },
      },
    },
  });
});

it("rejects unavailable tools on a dormant systemEvent update before writing", async () => {
  await expect(
    executeCron(
      updateJob("job-dormant", { payload: { kind: "systemEvent", toolsAllow: ["read", "exec"] } }),
      restrictedCaller,
    ),
  ).rejects.toThrow('Requested automation tool "exec" cannot be carried');
  expect(callGatewayMock).not.toHaveBeenCalled();
});

it("does not stamp caller sessionKey when add targets isolated session", async () => {
  await executeCron(addJob({ name: "isolated run", sessionTarget: "isolated" }), {
    agentSessionKey: "agent:main:webchat:dm:dashboard",
  });
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
  await executeCron(
    {
      ...addJob({ payload: { kind: "systemEvent", text: "Reminder: the thing." } }),
      contextMessages: 20,
    },
    { agentSessionKey: "main" },
  );
  expect(callGatewayMock).toHaveBeenCalledTimes(2);
  expect(readGatewayCall(0)).toMatchObject({ method: "chat.history", params: { limit: 10 } });
  const text = (readGatewayCall(1).params?.payload as { text?: string } | undefined)?.text ?? "";
  expect(text).not.toMatch(/Message [12]\b/);
  expect(text).toContain("Recent context:");
  expect(text).toContain("User: Message 3");
  expect(text).toContain("Assistant: Message 12");
});

it("strips null clears from add jobs before the strict gateway create contract (#121606)", async () => {
  await executeCron({
    action: "add",
    job: {
      ...reminder(),
      displayName: null,
      pacing: null,
      trigger: null,
      sessionKey: null,
      payload: agentTurn({ model: null, fallbacks: null }),
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
    name: "webhook does not infer announce delivery",
    agentSessionKey: "agent:main:discord:dm:buddy",
    delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
    expected: { mode: "webhook", to: "https://example.invalid/cron-finished" },
  },
])("$name", async ({ name: _name, expected, ...params }) => {
  expect(await executeAddAndReadDelivery(params)).toEqual(expected);
});

it("recovers flat text and toolsAllow as a systemEvent payload", async () => {
  await executeCron({
    action: "add",
    name: "flat-system-event",
    schedule: { kind: "every", everyMs: 60_000 },
    text: "tick",
    toolsAllow: [" read ", " cron "],
  });
  const params = expectSingleCall("cron.add");
  expect(params).toHaveProperty("payload", {
    kind: "systemEvent",
    text: "tick",
    toolsAllow: ["read", "cron"],
  });
});

it("rejects kind-less edits to stored command payloads", async () => {
  callGatewayMock.mockResolvedValueOnce({
    id: "job-command",
    trigger: { script: "json({ fire: true })" },
    payload: { kind: "command", argv: ["echo", "before"] },
  });
  const payload = { argv: ["sh", "-lc", "echo bypass"] };
  await expect(executeCron(updateJob("job-command", { payload }))).rejects.toThrow(commandError);
  expect(expectSingleCall("cron.get")).toEqual({ id: "job-command" });
});

it.each([
  {
    name: "clearing toolsAllow on an agentTurn",
    current: { kind: "agentTurn", message: "before" },
    job: { payload: { toolsAllow: null } },
    expected: { payload: { kind: "agentTurn", toolsAllow: ["*"] } },
  },
  {
    name: "converting a systemEvent to an agentTurn",
    current: { kind: "systemEvent", text: "hello" },
    job: { sessionTarget: "isolated", payload: { kind: "agentTurn", message: "run later" } },
    expected: {
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "run later", toolsAllow: ["*"] },
    },
  },
])("restores the wildcard cap when $name", async ({ current, job, expected }) => {
  callGatewayMock.mockResolvedValueOnce({ id: "job-8", payload: current });
  await executeCron(updateJob("job-8", job), restrictedCaller);
  expect(callGatewayMock).toHaveBeenCalledTimes(2);
  expect(readGatewayCall(1)).toEqual({
    method: "cron.update",
    params: { id: "job-8", expectedConfigRevision: "sha256:test", patch: expected },
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
      ...storedAgentTurn("sha256:first"),
    })
    .mockImplementationOnce(async () => {
      writeIdentities.push(getGatewayToolCallerIdentity());
      throw conflict;
    })
    .mockResolvedValueOnce({
      id: "job-resolve-race",
      ...storedAgentTurn("sha256:second", []),
    })
    .mockImplementationOnce(async () => {
      const identity = getGatewayToolCallerIdentity();
      writeIdentities.push(identity);
      consumeCronCreatorAuthorityGrant(identity!.cronCreatorAuthorityGrant!);
      return ok;
    });
  const resolveCreatorToolAuthority = vi.fn(async () =>
    resolvedCreatorAuthority(["read", "configured__lookup"], authorityGrant),
  );
  const tool = authorizedTool(resolveCreatorToolAuthority);
  await tool.execute(
    "call-update-resolve-race",
    updateJob("job-resolve-race", { payload: { toolsAllow: ["*"] } }),
    operation.signal,
  );
  expect(resolveCreatorToolAuthority).toHaveBeenCalledOnce();
  const wildcardPatch = { payload: { kind: "agentTurn", toolsAllow: ["*"] } };
  expect(readGatewayCall(1).params).toMatchObject({ patch: wildcardPatch });
  expect(readGatewayCall(3).params).toMatchObject({
    expectedConfigRevision: "sha256:second",
    patch: wildcardPatch,
  });
  const expectedIdentity = expect.objectContaining({
    cronToolsAllowCapture: "final-executable-surface",
    cronCreatorAuthorityGrant: authorityGrant,
  });
  expect(writeIdentities).toEqual([expectedIdentity, expectedIdentity]);
  expect(() => consumeCronCreatorAuthorityGrant(authorityGrant)).toThrow(
    "Configured MCP cron authority is no longer active",
  );
  revokeCronCreatorAuthorityRunScope(authorityScope);
});

it.each([
  {
    name: "fresh authority requires authenticated grant transport",
    id: "job-no-caller-identity",
    current: storedAgentTurn("sha256:no-caller-identity"),
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
    current: storedAgentTurn("sha256:incomplete-authority"),
    payload: { kind: "agentTurn", toolsAllow: ["future__tool"] },
    options: { ...restrictedCaller, creatorToolAllowlistCaptureRef: {} },
    error: "fresh authenticated direct-local operator turn",
  },
  {
    name: "updates require a current config revision",
    id: "job-no-revision",
    current: storedAgentTurn(null, ["read"], "hello"),
    payload: { message: "updated" },
    options: { creatorToolAllowlist: ["read", "cron"] },
    error: "cron.get response is missing configRevision",
  },
])("$name", async ({ id, current, payload, options, error }) => {
  callGatewayMock.mockResolvedValueOnce({ id, ...current });
  await expect(executeCron(updateJob(id, { payload }), options)).rejects.toThrow(error);
  expect(expectSingleCall("cron.get")).toEqual({ id });
});
