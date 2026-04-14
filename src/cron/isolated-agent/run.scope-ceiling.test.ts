/**
 * Scope ceiling tests for cron isolated agent execution.
 *
 * Security proposition (martingarramon, PR #65325):
 * A write-scope client creates a cron job. The job executes with the client's
 * stored scopes as an upper bound — it must NOT be able to call admin-required
 * gateway methods even when senderIsOwner=true in the CLI path.
 *
 * Tests use the real authorizeOperatorScopesForMethod and the same tool→method
 * name mapping that attempt.ts applies at tool-filter time.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_SCOPE,
  authorizeOperatorScopesForMethod,
  PAIRING_SCOPE,
  READ_SCOPE,
  resolveLeastPrivilegeOperatorScopesForMethod,
  WRITE_SCOPE,
} from "../../gateway/method-scopes.js";
import {
  clearFastTestEnv,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runCliAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

// Tool name → gateway method name (same transform as attempt.ts)
function toolToMethod(toolName: string): string {
  return toolName.replace(/_/g, ".");
}

// Simulates the scope-ceiling filter in attempt.ts
function scopeCeilingFilter(toolNames: string[], operatorScopes: readonly string[]): string[] {
  return toolNames.filter((name) => {
    const method = toolToMethod(name);
    return authorizeOperatorScopesForMethod(method, operatorScopes).allowed;
  });
}

const ADMIN_TOOLS = [
  "config_patch", "update_run", "secrets_reload", "secrets_resolve",
  "wizard_start", "agents_create", "agents_update", "agents_delete",
  "skills_install", "skills_update", "sessions_patch", "sessions_reset",
  "sessions_delete", "sessions_compact", "chat_inject", "connect",
] as const;

const WRITE_TOOLS = [
  "message_action", "chat_send", "sessions_create", "sessions_send",
  "sessions_steer", "sessions_abort", "node_invoke", "cron_add", "push_test",
] as const;

const PAIRING_TOOLS = [
  "node_pair_request", "node_pair_list", "node_pair_reject",
  "node_pair_verify", "node_pair_approve", "device_pair_list",
] as const;

// =============================================================================
// Unit-level tests: scope ceiling filter logic
// =============================================================================

describe("scope ceiling: write-scope job cannot call admin-required gateway methods", () => {
  it("config.patch is admin-required", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("config.patch")).toEqual([ADMIN_SCOPE]);
  });
  it("update.run is admin-required", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("update.run")).toEqual([ADMIN_SCOPE]);
  });
  it("secrets.resolve is admin-required", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("secrets.resolve")).toEqual([ADMIN_SCOPE]);
  });
  it("wizard.start is admin-required", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("wizard.start")).toEqual([ADMIN_SCOPE]);
  });
  it("write-scope job: all admin tools are BLOCKED", () => {
    expect(scopeCeilingFilter([...ADMIN_TOOLS], [WRITE_SCOPE])).toHaveLength(0);
  });
  it("write-scope job: write tools are ALLOWED", () => {
    expect(scopeCeilingFilter([...WRITE_TOOLS], [WRITE_SCOPE])).toEqual([...WRITE_TOOLS]);
  });
  it("write-scope job: read tools are ALLOWED (write includes read)", () => {
    const allowed = scopeCeilingFilter(
      ["health", "status", "logs_tail", "config_get", "config_schema_lookup"],
      [WRITE_SCOPE],
    );
    expect(allowed).toHaveLength(5);
  });
  it("write-scope job: pairing tools are BLOCKED", () => {
    expect(scopeCeilingFilter([...PAIRING_TOOLS], [WRITE_SCOPE])).toHaveLength(0);
  });
  it("admin-scope job: admin tools are ALLOWED", () => {
    expect(scopeCeilingFilter([...ADMIN_TOOLS], [ADMIN_SCOPE])).toEqual([...ADMIN_TOOLS]);
  });
  it("read-scope job: read tools are ALLOWED", () => {
    const allowed = scopeCeilingFilter(
      ["health", "status", "config_get", "config_schema_lookup"],
      [READ_SCOPE],
    );
    expect(allowed).toHaveLength(4);
  });
  it("read-scope job: write tools are BLOCKED", () => {
    expect(scopeCeilingFilter([...WRITE_TOOLS], [READ_SCOPE])).toHaveLength(0);
  });
  it("empty scopes: ALL tools are BLOCKED", () => {
    expect(scopeCeilingFilter([...ADMIN_TOOLS, ...WRITE_TOOLS], [])).toHaveLength(0);
  });
  it("unclassified tools default to admin-required", () => {
    const result = authorizeOperatorScopesForMethod("some.random.method", [WRITE_SCOPE]);
    expect(result).toEqual({ allowed: false, missingScope: ADMIN_SCOPE });
  });
});

describe("scope ceiling: real admin tool names from attempt.ts", () => {
  const realAdminToolNames = [
    "config_patch", "update_run", "secrets_resolve", "wizard_start",
    "agents_create", "agents_delete", "skills_install",
    "sessions_patch", "sessions_reset", "sessions_delete",
    "sessions_compact", "chat_inject",
  ] as const;

  it("write-scope job: ALL real admin tool names are filtered out", () => {
    expect(scopeCeilingFilter([...realAdminToolNames], [WRITE_SCOPE])).toHaveLength(0);
  });
  it("admin-scope job: ALL real admin tool names are allowed", () => {
    expect(scopeCeilingFilter([...realAdminToolNames], [ADMIN_SCOPE])).toEqual([...realAdminToolNames]);
  });
  it("write+read scopes: read tools ALLOWED, admin tools still BLOCKED", () => {
    const readTools = ["health", "status", "config_get"];
    const allowed = scopeCeilingFilter([...realAdminToolNames, ...readTools], [WRITE_SCOPE, READ_SCOPE]);
    expect(allowed).toEqual(readTools);
  });
});

// =============================================================================
// Integration tests: CLI + PI-agent path scope ceiling propagation
// =============================================================================

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function mockCliFallbackInvocation() {
  runWithModelFallbackMock.mockImplementationOnce(
    async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
      const result = await params.run("claude-cli", "claude-opus-4-6");
      return { result, provider: "claude-cli", model: "claude-opus-4-6", attempts: [] };
    },
  );
}

function makeJob(overrides?: Record<string, unknown>) {
  return {
    id: "test-job",
    name: "Test Job",
    creatorScopes: undefined,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "test" },
    ...overrides,
  } as Record<string, unknown>;
}

function makeParams(overrides?: Record<string, unknown>) {
  const jobOverrides = overrides && "job" in overrides ? overrides.job as Record<string, unknown> | undefined : undefined;
  return {
    cfg: {} as Record<string, unknown>,
    deps: {} as never,
    job: makeJob(jobOverrides),
    message: "test",
    sessionKey: "cron:test",
    ...overrides,
  };
}

describe("CLI path: creatorScopes is propagated to runCliAgent as operatorScopes", () => {
  let previousFastTestEnv: string | undefined;
  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronSessionMock.mockReturnValue(makeCronSession());
  });
  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("write-scope job: operatorScopes=['operator.write'] passed to runCliAgent", async () => {
    isCliProviderMock.mockReturnValue(true);
    mockCliFallbackInvocation();
    await runCronIsolatedAgentTurn(makeParams({ job: makeJob({ creatorScopes: [WRITE_SCOPE] }) }));
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    const call = runCliAgentMock.mock.calls[0][0];
    expect(call.senderIsOwner).toBe(true);
    expect(call.operatorScopes).toEqual([WRITE_SCOPE]);
  });

  it("admin-scope job: operatorScopes=['operator.admin'] passed to runCliAgent", async () => {
    isCliProviderMock.mockReturnValue(true);
    mockCliFallbackInvocation();
    await runCronIsolatedAgentTurn(makeParams({ job: makeJob({ creatorScopes: [ADMIN_SCOPE] }) }));
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    const call = runCliAgentMock.mock.calls[0][0];
    expect(call.senderIsOwner).toBe(true);
    expect(call.operatorScopes).toEqual([ADMIN_SCOPE]);
  });

  it("no-scope job (CLI-created): operatorScopes is undefined", async () => {
    isCliProviderMock.mockReturnValue(true);
    mockCliFallbackInvocation();
    await runCronIsolatedAgentTurn(makeParams({ job: makeJob({ creatorScopes: undefined }) }));
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    const call = runCliAgentMock.mock.calls[0][0];
    expect(call.operatorScopes).toBeUndefined();
  });

  it("read+write scopes: both passed to runCliAgent", async () => {
    isCliProviderMock.mockReturnValue(true);
    mockCliFallbackInvocation();
    await runCronIsolatedAgentTurn(
      makeParams({ job: makeJob({ creatorScopes: [READ_SCOPE, WRITE_SCOPE] }) }),
    );
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    const call = runCliAgentMock.mock.calls[0][0];
    expect(call.operatorScopes).toEqual([READ_SCOPE, WRITE_SCOPE]);
  });

  it("senderIsOwner=true does NOT override operatorScopes ceiling", async () => {
    // martingarramon concern: CLI path has senderIsOwner=true, but the scope ceiling
    // filter only checks operatorScopes. With operatorScopes=[WRITE_SCOPE], admin tools
    // are blocked regardless of senderIsOwner.
    isCliProviderMock.mockReturnValue(true);
    mockCliFallbackInvocation();
    await runCronIsolatedAgentTurn(makeParams({ job: makeJob({ creatorScopes: [WRITE_SCOPE] }) }));
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    const call = runCliAgentMock.mock.calls[0][0];
    expect(call.senderIsOwner).toBe(true);
    expect(call.operatorScopes).toEqual([WRITE_SCOPE]);
    // Sanity: with WRITE_SCOPE, admin tools are blocked
    const allowed = scopeCeilingFilter(["config_patch", "update_run", "chat_send"], [WRITE_SCOPE]);
    expect(allowed).toEqual(["chat_send"]);
  });
});

describe("PI-agent path: creatorScopes is propagated (senderIsOwner=false)", () => {
  let previousFastTestEnv: string | undefined;
  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronSessionMock.mockReturnValue(makeCronSession());
  });
  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("write-scope job: goes through PI-agent path (not CLI)", async () => {
    isCliProviderMock.mockReturnValue(false);
    mockCliFallbackInvocation();
    await runCronIsolatedAgentTurn(makeParams({ job: makeJob({ creatorScopes: [WRITE_SCOPE] }) }));
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runWithModelFallbackMock).toHaveBeenCalled();
  });

  it("no-scope job: goes through PI-agent path", async () => {
    isCliProviderMock.mockReturnValue(false);
    mockCliFallbackInvocation();
    await runCronIsolatedAgentTurn(makeParams({ job: makeJob({ creatorScopes: undefined }) }));
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(runWithModelFallbackMock).toHaveBeenCalled();
  });
});
