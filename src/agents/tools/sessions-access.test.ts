import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { pageExecutionDecisionFactsForContextInDatabase } from "../../audit/execution-decision-facts.js";
import { configureExecutionDecisionWorkSink } from "../../audit/execution-decision-work.js";
import {
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
} from "../../audit/execution-identity-admission.js";
import { startAgentLocalAuditWriter } from "../../commands/agent-local-audit.js";
import type { OpenClawConfig } from "../../config/config.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityChecker,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  resolveSessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  formatSessionToolAccessDenial,
  resolveSandboxedSessionToolContext,
  resolveSessionToolAccess,
} from "./sessions-access.js";

const loggerMocks = vi.hoisted(() => ({ logWarn: vi.fn() }));
const gatewayMocks = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logger.js")>()),
  logWarn: loggerMocks.logWarn,
}));
vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: gatewayMocks.callGateway,
}));

beforeEach(() => {
  gatewayMocks.callGateway.mockReset();
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const AUDIT_REF_RE = /^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u;
const requesterSessionKey = "agent:main:main";
const ownershipEvidence = {
  reasonCode: "session_ownership_lookup_failed_transient",
  policyRefs: ["tools.sessions.visibility"],
  contextFieldsUsed: ["requesterSessionKey", "targetSessionKey"],
  missingEvidence: ["session.owner"],
} satisfies Parameters<typeof expectDenial>[1];
const disabledEvidence = {
  reasonCode: "agent_to_agent_disabled",
  policyRefs: ["tools.agentToAgent.enabled"],
  contextFieldsUsed: ["requesterAgentId", "targetAgentId"],
  missingEvidence: [],
} satisfies Parameters<typeof expectDenial>[1];

function unavailable(message = "transport timeout") {
  return new GatewayClientRequestError({ code: "UNAVAILABLE", message, retryable: true });
}

function failingGateway(message?: string) {
  return vi.fn(async (_request: { method?: string }) => {
    throw unavailable(message);
  });
}

function expectDenial(
  result: Awaited<ReturnType<typeof resolveSessionToolAccess>>,
  evidence: Omit<Parameters<typeof formatSessionToolAccessDenial>[0], "allowed" | "status">,
) {
  expect(result).toEqual({ allowed: false, status: "forbidden", ...evidence });
  if (result.allowed) {
    throw new Error("Expected denied session access");
  }
  return result;
}

function allowAgents(allow: string[]) {
  return createAgentToAgentPolicy({ tools: { agentToAgent: { enabled: true, allow } } });
}

function resolveAccess(overrides: Partial<Parameters<typeof resolveSessionToolAccess>[0]>) {
  return resolveSessionToolAccess({
    action: "history",
    requesterAgentId: "main",
    requesterSessionKey,
    targetAgentId: "main",
    targetSessionKey: "agent:main:subagent:worker",
    requesterOwned: false,
    visibility: "tree",
    a2aPolicy: createAgentToAgentPolicy({}),
    ...overrides,
  });
}

it("resolveSessionToolsVisibility defaults to all when unset or invalid", () => {
  expect(resolveSessionToolsVisibility({})).toBe("all");
  expect(
    resolveSessionToolsVisibility({
      tools: { sessions: { visibility: "invalid" } },
    } as unknown as OpenClawConfig),
  ).toBe("all");
});

it("restricts non-subagent sandboxed sessions to spawned visibility", () => {
  const cfg: OpenClawConfig = {
    tools: { sessions: { visibility: "all" } },
    agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
  };
  const context = resolveSandboxedSessionToolContext({
    cfg,
    agentSessionKey: requesterSessionKey,
    sandboxed: true,
  });

  expect(context).toMatchObject({
    restrictToSpawned: true,
    requesterInternalKey: requesterSessionKey,
    effectiveRequesterKey: requesterSessionKey,
  });
  expect(context.mainSessionKey).toBeUndefined();
});

it("resolves the canonical global main key from its explicit store owner", () => {
  const context = resolveSandboxedSessionToolContext({
    cfg: {
      session: { scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    },
    agentSessionKey: "global",
    requesterAgentId: "ops",
  });

  expect(context.mainSessionKey).toBe("global");
});
it.each([
  { pattern: "Ops", accepted: "Ops", rejected: "ops" },
  { pattern: "ops.[prod]*", accepted: "OPS.[PROD]-worker", rejected: "opsXprod-worker" },
])("matches $pattern without reinterpreting literal text", ({ pattern, accepted, rejected }) => {
  const policy = allowAgents([pattern]);
  expect([policy.matchesAllow(accepted), policy.matchesAllow(rejected)]).toEqual([true, false]);
});

it("handles multiple wildcards without polynomial backtracking", () => {
  const policy = allowAgents(["*a*b*c*d*e*"]);
  expect(policy.matchesAllow("xaxbxcxdxe")).toBe(true);
  // The former greedy regex has polynomial backtracking on this negative input.
  const adversarial = "a".repeat(200) + "b".repeat(200) + "c".repeat(200) + "d".repeat(200);
  const start = performance.now();
  expect(policy.matchesAllow(adversarial)).toBe(false);
  expect(performance.now() - start).toBeLessThan(50);
});
it("keeps agent visibility same-agent-only for cross-agent owned child rows", () => {
  const guard = createSessionVisibilityRowChecker({
    action: "list",
    requesterSessionKey,
    visibility: "agent",
    a2aPolicy: allowAgents(["main", "codex"]),
  });

  expect(
    guard.check({
      key: "agent:codex:acp:child-1",
      spawnedBy: requesterSessionKey,
    }),
  ).toEqual({
    allowed: false,
    status: "forbidden",
    error:
      "Session list visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access; use tools.agentToAgent to restrict permitted agent pairs.",
  });
});

it.each(["exact", "fallback"] as const)(
  "finds same-agent spawned targets via %s lookup",
  async (mode) => {
    const targetSessionKey = `agent:main:subagent:${mode === "exact" ? "worker-999" : "worker"}`;
    const gateway = vi.fn(async (request: { method?: string; params?: { key?: string } }) => {
      if (request.method === "sessions.resolve") {
        if (mode === "fallback") {
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "unknown method: sessions.resolve",
          });
        }
        return { key: request.params?.key };
      }
      return mode === "exact" ? {} : { sessions: [{ key: targetSessionKey }] };
    });

    const access = await resolveAccess({
      targetSessionKey,
      callGateway: gateway as never,
    });

    expect(access).toEqual({ allowed: true });
    expect(gateway.mock.calls.map(([request]) => request.method)).toEqual([
      "sessions.describe",
      "sessions.resolve",
      ...(mode === "fallback" ? ["sessions.list"] : []),
    ]);
  },
);

it.each([
  { action: "send" as const },
  { action: "history" as const, displayAction: "search" as const },
])("does not grant durable-row ownership to $action tools", async ({ action, displayAction }) => {
  const parentKey = "agent:main:subagent:parent";
  const targetSessionKey = "agent:main:subagent:old-child";
  const gateway = vi.fn(async (_request: { method?: string }) => ({}));

  const access = await resolveAccess({
    action,
    displayAction,
    requesterSessionKey: parentKey,
    targetSessionKey,
    callGateway: gateway as never,
  });

  expect(access).toMatchObject({ allowed: false, reasonCode: "tree_visibility_restricted" });
  expect(gateway.mock.calls.map(([request]) => request.method)).toEqual(["sessions.resolve"]);
});

it("persists unknown ownership evidence with an opaque target through the local writer", async () => {
  const now = Date.now();
  const stateDir = tempDirs.make("openclaw-session-access-audit-");
  const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const stopWriter = startAgentLocalAuditWriter(
    { logging: { audit: { executionIdentity: true } } },
    { stateDir },
  );
  if (!stopWriter) {
    throw new Error("expected an isolated direct-local audit writer");
  }
  const token = createExecutionIdentityAdmissionToken("session-access-run", {
    contextId: "session-access-context",
    executionId: "session-access-execution",
    now,
  });
  expect(
    enqueueExecutionIdentityContextAtAdmission(
      {
        runId: token.runId,
        agentId: "main",
        ingress: { kind: "local-cli", boundary: "agent-command.local" },
        runtime: { kind: "embedded" },
      },
      { enabled: true, token, runtimeInstanceId: "session-access-runtime" },
    ),
  ).toMatchObject({ accepted: true });

  const targetSessionKey = "agent:main:dashboard:owner-unknown";
  gatewayMocks.callGateway.mockRejectedValue(unavailable());
  try {
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: requesterSessionKey,
        executionIdentityToken: token,
        receiptAuthority: () => true,
      },
      async () => {
        const access = await resolveAccess({
          action: "send",
          targetSessionKey,
        });
        expect(access).toMatchObject({
          allowed: false,
          reasonCode: ownershipEvidence.reasonCode,
          contextFieldsUsed: ownershipEvidence.contextFieldsUsed,
          missingEvidence: ownershipEvidence.missingEvidence,
        });
      },
    );
  } finally {
    await stopWriter();
  }

  const page = pageExecutionDecisionFactsForContextInDatabase(
    openOpenClawStateDatabase(database).db,
    { context: token, limit: 10, now: now + 1 },
  );
  expect(page.receipts).toHaveLength(1);
  expect(page.receipts[0]).toMatchObject({
    contextId: token.contextId,
    executionId: token.executionId,
    runId: token.runId,
    action: {
      family: "session",
      operation: "send",
      targetRef: expect.stringMatching(AUDIT_REF_RE),
    },
    decision: { outcome: "denied", reasonCode: ownershipEvidence.reasonCode },
    enforcement: {
      coverageState: "unknown",
      policyRefs: ownershipEvidence.policyRefs,
      contextFieldsUsed: ownershipEvidence.contextFieldsUsed,
    },
    missingEvidence: ownershipEvidence.missingEvidence,
  });
  expect(JSON.stringify(page.receipts)).not.toContain(targetSessionKey);
});

it("revalidates the exact receipt authority after awaited ownership lookup", async () => {
  const decisionWork: unknown[] = [];
  const clear = configureExecutionDecisionWorkSink((work) => {
    decisionWork.push(work);
    return true;
  });
  const token = createExecutionIdentityAdmissionToken("session-access-closed-run", {
    contextId: "session-access-closed-context",
    executionId: "session-access-closed-execution",
  });
  let authorityActive = true;
  gatewayMocks.callGateway.mockImplementation(async () => {
    authorityActive = false;
    return { sessions: [] };
  });
  try {
    const access = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: requesterSessionKey,
        executionIdentityToken: token,
        receiptAuthority: () => authorityActive,
      },
      async () =>
        await resolveAccess({
          targetSessionKey: "agent:main:dashboard:unowned",
        }),
    );

    expect(access).toMatchObject({ allowed: false, reasonCode: "tree_visibility_restricted" });
    expect(decisionWork).toEqual([]);
  } finally {
    clear();
  }
});

it.each([
  [
    "send",
    "ops",
    "agent:ops:main",
    "all",
    disabledEvidence,
    "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
    [],
  ],
  [
    "history",
    "codex",
    "agent:codex:acp:child-1",
    "tree",
    ownershipEvidence,
    "Session history denied because spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.",
    ["sessions.describe", "sessions.resolve"],
  ],
] as const)(
  "preserves %s denial guidance for %s",
  async (action, targetAgentId, targetSessionKey, visibility, evidence, message, methods) => {
    const gateway = failingGateway();
    const access = await resolveAccess({
      action,
      targetAgentId,
      targetSessionKey,
      visibility,
      a2aPolicy: createAgentToAgentPolicy(
        action === "send" ? { tools: { agentToAgent: { enabled: false } } } : {},
      ),
      callGateway: gateway as never,
    });
    const denial = expectDenial(access, evidence);
    expect(formatSessionToolAccessDenial(denial, { action })).toBe(message);
    expect(gateway.mock.calls.map(([request]) => request.method)).toEqual(methods);
  },
);

it("does not apply a bare-key scoped grant to another agent's session", async () => {
  const targets: string[] = [];
  const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) => {
    targets.push(request.targetSessionKey);
    return request.targetSessionKey === "shared" ? { expectedSessionId: "agent-a" } : undefined;
  });
  try {
    const gateway = vi.fn();
    const access = await resolveAccess({
      authorizationTargetSessionKey: "agent:ops:shared",
      targetAgentId: "ops",
      targetSessionKey: "shared",
      visibility: "self",
      callGateway: gateway as never,
    });

    expect(access.allowed).toBe(false);
    expect(targets).toEqual(["agent:ops:shared"]);
    expect(gateway).not.toHaveBeenCalled();
  } finally {
    unregister();
  }
});

it("keeps incognito targets hidden from scoped grants", async () => {
  const targetSessionKey = "agent:main:dashboard:incognito-private";
  const asyncProvider = vi.fn(async () => ({ expectedSessionId: "incognito-incarnation" }));
  const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(
    () => ({ expectedSessionId: "incognito-incarnation" }),
    { resolveAsync: asyncProvider },
  );
  try {
    const gateway = vi.fn();
    const access = await resolveAccess({
      targetSessionKey,
      requesterOwned: true,
      visibility: "all",
      callGateway: gateway as never,
    });

    const denial = expectDenial(access, {
      reasonCode: "incognito_session",
      policyRefs: ["sessions.incognito"],
      contextFieldsUsed: ["targetSessionKey"],
      missingEvidence: [],
    });
    expect(formatSessionToolAccessDenial(denial, { action: "history", targetSessionKey })).toBe(
      `Session not visible from session tools: ${targetSessionKey}`,
    );
    expect(gateway).not.toHaveBeenCalled();
    expect(asyncProvider).not.toHaveBeenCalled();
  } finally {
    unregister();
  }
});

it("reports a transient tree-visibility lookup failure distinctly", async () => {
  loggerMocks.logWarn.mockClear();
  const guard = await createSessionVisibilityGuard({
    action: "history",
    requesterSessionKey,
    visibility: "tree",
    a2aPolicy: createAgentToAgentPolicy({}),
    callGateway: failingGateway(
      "transport timeout Authorization: Bearer sk-evidence-secret-9f3a2c",
    ) as never,
  });

  const result = guard.check("agent:main:subagent:child-1");
  expect(result).toMatchObject({ allowed: false, status: "forbidden" });
  if (!result.allowed) {
    expect(result.error).toMatch(/ownership lookup failed/i);
    expect(result.error).toMatch(/transient\); retry/i);
  }
  const warnText = loggerMocks.logWarn.mock.calls.map((call) => String(call[0])).join("\n");
  expect(warnText).toMatch(/requester=sha256:[a-f0-9]{12}/u);
  expect(warnText).not.toContain("agent:main:main");
  expect(warnText).not.toContain("sk-evidence-secret-9f3a2c");
});
