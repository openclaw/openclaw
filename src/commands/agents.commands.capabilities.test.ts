import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentsCapabilitiesCommand } from "./agents.commands.capabilities.js";

const mocks = vi.hoisted(() => ({
  requireValidConfigMock: vi.fn(),
  resolveProviderAuthEnvVarCandidatesMock: vi.fn(),
  ensureAuthProfileStoreMock: vi.fn(),
  resolveAuthProfileOrderMock: vi.fn(),
  resolveUsableCustomProviderApiKeyMock: vi.fn(),
}));

vi.mock("./agents.command-shared.js", () => ({
  requireValidConfig: mocks.requireValidConfigMock,
}));

vi.mock("../secrets/provider-env-vars.js", () => ({
  resolveProviderAuthEnvVarCandidates: mocks.resolveProviderAuthEnvVarCandidatesMock,
}));

vi.mock("../agents/auth-profiles/store.js", () => ({
  ensureAuthProfileStoreWithoutExternalProfiles: mocks.ensureAuthProfileStoreMock,
}));

vi.mock("../agents/auth-profiles/order.js", () => ({
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrderMock,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveUsableCustomProviderApiKey: mocks.resolveUsableCustomProviderApiKeyMock,
}));

function emptyStore(): AuthProfileStore {
  return { profiles: {}, order: {} } as unknown as AuthProfileStore;
}

function createRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const runtime: RuntimeEnv = {
    log: (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    },
    error: (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    },
    exit: (code: number) => {
      exits.push(code);
    },
  };
  return { runtime, logs, errors, exits };
}

const SECRET = "sk-ant-super-secret-value-9999";

function configWith(list: OpenClawConfig["agents"]): OpenClawConfig {
  return { agents: list } as unknown as OpenClawConfig;
}

describe("agentsCapabilitiesCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveProviderAuthEnvVarCandidatesMock.mockReturnValue({
      anthropic: ["ANTHROPIC_API_KEY"],
    });
    // Defaults: no auth profiles, no config-backed custom api key.
    mocks.ensureAuthProfileStoreMock.mockReturnValue(emptyStore());
    mocks.resolveAuthProfileOrderMock.mockReturnValue([]);
    mocks.resolveUsableCustomProviderApiKeyMock.mockReturnValue(null);
  });

  it("emits a JSON contract without leaking secret values (env credential)", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        list: [{ id: "peewee", model: "anthropic/claude-opus-4-7", tools: { allow: ["Read"] } }],
      }),
    );
    const { runtime, logs } = createRuntime();
    const env = { ANTHROPIC_API_KEY: SECRET } as unknown as NodeJS.ProcessEnv;

    await agentsCapabilitiesCommand({ json: true }, runtime, env);

    expect(logs).toHaveLength(1);
    const contract = JSON.parse(logs[0]);
    expect(contract.version).toBe(1);
    const profile = contract.profiles.find((p: { agentId: string }) => p.agentId === "peewee");
    expect(profile).toBeDefined();
    const creds = profile.checks.find((c: { id: string }) => c.id === "profile.credentials");
    expect(creds.status).toBe("green");
    // The secret value must never appear anywhere in the output.
    expect(logs[0]).not.toContain(SECRET);
  });

  it("treats a usable auth profile as present credentials (no env var)", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        list: [{ id: "peewee", model: "anthropic/claude-opus-4-7", tools: { allow: ["Read"] } }],
      }),
    );
    // Store has an OAuth profile whose credential happens to be secret-shaped.
    mocks.ensureAuthProfileStoreMock.mockReturnValue({
      profiles: { "anthropic-oauth": { provider: "anthropic", type: "oauth", access: SECRET } },
      order: {},
    } as unknown as AuthProfileStore);
    mocks.resolveAuthProfileOrderMock.mockReturnValue(["anthropic-oauth"]);

    const { runtime, logs } = createRuntime();
    // Deliberately empty env: only the auth profile store should satisfy the check.
    await agentsCapabilitiesCommand({ json: true }, runtime, {} as NodeJS.ProcessEnv);

    const contract = JSON.parse(logs[0]);
    const creds = contract.profiles[0].checks.find(
      (c: { id: string }) => c.id === "profile.credentials",
    );
    expect(creds.status).toBe("green");
    expect(creds.reason).toBe("ok");
    // A store-backed secret value must never surface in the rendered contract.
    expect(logs[0]).not.toContain(SECRET);
  });

  it("flags missing provider credentials as red", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        list: [{ id: "peewee", model: "anthropic/claude-opus-4-7", tools: { allow: ["Read"] } }],
      }),
    );
    const { runtime, logs } = createRuntime();
    const env = {} as NodeJS.ProcessEnv;

    await agentsCapabilitiesCommand({ json: true }, runtime, env);
    const contract = JSON.parse(logs[0]);
    const profile = contract.profiles[0];
    const creds = profile.checks.find((c: { id: string }) => c.id === "profile.credentials");
    expect(creds.status).toBe("red");
    expect(creds.reason).toBe("provider_credentials_missing");
  });

  it("never renders secret-shaped env values in any output format or remediation", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        list: [{ id: "peewee", model: "anthropic/claude-opus-4-7", tools: { allow: ["Read"] } }],
      }),
    );
    // Secret lives in an unrelated env var; the provider stays uncredentialed (red),
    // so the remediation hint is rendered — and must not echo the secret.
    const env = { UNRELATED_TOKEN: SECRET } as unknown as NodeJS.ProcessEnv;

    for (const opts of [{ json: true }, { markdown: true }, {}]) {
      const { runtime, logs } = createRuntime();
      await agentsCapabilitiesCommand(opts, runtime, env);
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain(SECRET);
    }

    // Assert specifically against the remediation detail string.
    const { runtime, logs } = createRuntime();
    await agentsCapabilitiesCommand({ json: true }, runtime, env);
    const contract = JSON.parse(logs[0]);
    const creds = contract.profiles[0].checks.find(
      (c: { id: string }) => c.id === "profile.credentials",
    );
    expect(creds.status).toBe("red");
    expect(creds.detail).not.toContain(SECRET);
  });

  it("treats agents.defaults.subagents.model as delegation configured", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        defaults: { subagents: { model: "anthropic/claude-haiku-4-5" } },
        list: [{ id: "peewee", model: "anthropic/claude-opus-4-7", tools: { allow: ["Read"] } }],
      } as unknown as OpenClawConfig["agents"]),
    );
    const { runtime, logs } = createRuntime();
    const env = { ANTHROPIC_API_KEY: SECRET } as unknown as NodeJS.ProcessEnv;

    await agentsCapabilitiesCommand({ json: true }, runtime, env);

    const contract = JSON.parse(logs[0]);
    const checks: Array<{ id: string; reason: string; status: string }> =
      contract.profiles[0].checks;
    // No per-agent `subagents` block, but delegation is inherited from defaults:
    // it must be reported as configured, not "not configured".
    expect(checks.some((c) => c.reason === "delegation_not_configured")).toBe(false);
    const delegationCreds = checks.find((c) => c.id === "profile.delegation.credentials");
    expect(delegationCreds?.status).toBe("green");
    expect(logs[0]).not.toContain(SECRET);
  });

  it("treats the primary-model fallback as delegation configured", async () => {
    // No subagents block anywhere: the runtime resolver falls back to the
    // agent primary model, so a spawned subagent would still run — delegation
    // must be reported as configured.
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        list: [{ id: "peewee", model: "anthropic/claude-opus-4-7", tools: { allow: ["Read"] } }],
      }),
    );
    const { runtime, logs } = createRuntime();
    const env = { ANTHROPIC_API_KEY: SECRET } as unknown as NodeJS.ProcessEnv;

    await agentsCapabilitiesCommand({ json: true }, runtime, env);

    const contract = JSON.parse(logs[0]);
    const checks: Array<{ id: string; reason: string; status: string }> =
      contract.profiles[0].checks;
    expect(checks.some((c) => c.reason === "delegation_not_configured")).toBe(false);
    const delegationCreds = checks.find((c) => c.id === "profile.delegation.credentials");
    expect(delegationCreds?.status).toBe("green");
    expect(logs[0]).not.toContain(SECRET);
  });

  it("checks credentials for the resolved delegation provider, not the primary", async () => {
    // Primary provider is anthropic (credentialed); delegation resolves to an
    // openai subagent model that has NO credentials. The delegation check must
    // reflect the openai provider, independent of the green primary check.
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        defaults: { subagents: { model: "openai/gpt-4o-mini" } },
        list: [{ id: "peewee", model: "anthropic/claude-opus-4-7", tools: { allow: ["Read"] } }],
      } as unknown as OpenClawConfig["agents"]),
    );
    const env = { ANTHROPIC_API_KEY: SECRET } as unknown as NodeJS.ProcessEnv;

    // Sanitized across every render path, including the remediation hint.
    for (const opts of [{ json: true }, { markdown: true }, {}]) {
      const { runtime, logs } = createRuntime();
      await agentsCapabilitiesCommand(opts, runtime, env);
      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain(SECRET);
    }

    const { runtime, logs } = createRuntime();
    await agentsCapabilitiesCommand({ json: true }, runtime, env);
    const contract = JSON.parse(logs[0]);
    const checks: Array<{ id: string; reason: string; status: string; detail?: string }> =
      contract.profiles[0].checks;
    const primaryCreds = checks.find((c) => c.id === "profile.credentials");
    expect(primaryCreds?.status).toBe("green");
    const delegationCreds = checks.find((c) => c.id === "profile.delegation.credentials");
    expect(delegationCreds?.status).toBe("yellow");
    expect(delegationCreds?.reason).toBe("delegation_credentials_missing");
    // Remediation names the resolved provider but never echoes a secret.
    expect(delegationCreds?.detail).toContain("openai");
    expect(delegationCreds?.detail ?? "").not.toContain(SECRET);
  });

  it("resolves a configured delegation alias to its real provider", async () => {
    // agents.defaults.subagents.model is a config-defined alias ("gpt") that the
    // runtime spawn resolver expands to a fully-qualified openai/* model. The
    // command must mirror that expansion so credentials are checked against the
    // provider that will actually run (openai) rather than the bare alias —
    // which derives to no provider and would render "unknown".
    mocks.resolveProviderAuthEnvVarCandidatesMock.mockReturnValue({
      anthropic: ["ANTHROPIC_API_KEY"],
      openai: ["OPENAI_API_KEY"],
    });
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        defaults: {
          subagents: { model: "gpt" },
          models: { "openai/gpt-4o-mini": { alias: "gpt" } },
        },
        list: [{ id: "peewee", model: "anthropic/claude-opus-4-7", tools: { allow: ["Read"] } }],
      } as unknown as OpenClawConfig["agents"]),
    );
    // Only the openai credential is present; the alias must resolve to openai
    // for the delegation check to come back green.
    const env = { OPENAI_API_KEY: SECRET } as unknown as NodeJS.ProcessEnv;

    const { runtime, logs } = createRuntime();
    await agentsCapabilitiesCommand({ json: true }, runtime, env);

    const contract = JSON.parse(logs[0]);
    const checks: Array<{ id: string; reason: string; status: string; detail?: string }> =
      contract.profiles[0].checks;
    expect(checks.some((c) => c.reason === "delegation_not_configured")).toBe(false);
    const delegationCreds = checks.find((c) => c.id === "profile.delegation.credentials");
    expect(delegationCreds?.status).toBe("green");
    expect(delegationCreds?.reason).toBe("ok");
    // The alias resolved to a real provider, so no "unknown" provider surfaces.
    expect(logs[0]).not.toContain("unknown");
    expect(logs[0]).not.toContain(SECRET);
  });

  it("falls back to agents.defaults.model primary when no subagent/agent model is set", async () => {
    // No subagents.model anywhere and no agent-local model: the runtime spawn
    // path falls back to agents.defaults.model.primary, so a spawned subagent
    // would still run. Delegation must NOT report not-configured, and
    // credentials must be checked for the default-primary provider (anthropic).
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        defaults: { model: { primary: "anthropic/claude-opus-4-7" } },
        list: [{ id: "peewee", tools: { allow: ["Read"] } }],
      } as unknown as OpenClawConfig["agents"]),
    );
    const env = { ANTHROPIC_API_KEY: SECRET } as unknown as NodeJS.ProcessEnv;

    const { runtime, logs } = createRuntime();
    await agentsCapabilitiesCommand({ json: true }, runtime, env);

    const contract = JSON.parse(logs[0]);
    const checks: Array<{ id: string; reason: string; status: string }> =
      contract.profiles[0].checks;
    expect(checks.some((c) => c.reason === "delegation_not_configured")).toBe(false);
    const delegationCreds = checks.find((c) => c.id === "profile.delegation.credentials");
    expect(delegationCreds?.status).toBe("green");
    expect(delegationCreds?.reason).toBe("ok");
    expect(logs[0]).not.toContain("unknown");
    expect(logs[0]).not.toContain(SECRET);
  });

  it("filters to a single agent via --agent", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({
        list: [
          { id: "peewee", model: "anthropic/claude-opus-4-7" },
          { id: "rico", model: "anthropic/claude-haiku-4-5" },
        ],
      }),
    );
    const { runtime, logs } = createRuntime();

    await agentsCapabilitiesCommand(
      { json: true, agent: "rico" },
      runtime,
      {} as NodeJS.ProcessEnv,
    );
    const contract = JSON.parse(logs[0]);
    expect(contract.profiles).toHaveLength(1);
    expect(contract.profiles[0].agentId).toBe("rico");
  });

  it("renders markdown when --markdown is set", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({ list: [{ id: "peewee", model: "anthropic/claude-opus-4-7" }] }),
    );
    const { runtime, logs } = createRuntime();

    await agentsCapabilitiesCommand({ markdown: true }, runtime, {} as NodeJS.ProcessEnv);
    expect(logs[0]).toContain("# Fleet Capability Contract v1");
  });

  it("renders human text by default", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(
      configWith({ list: [{ id: "peewee", model: "anthropic/claude-opus-4-7" }] }),
    );
    const { runtime, logs } = createRuntime();

    await agentsCapabilitiesCommand({}, runtime, {} as NodeJS.ProcessEnv);
    expect(logs[0]).toContain("Fleet Capability Contract v1");
    expect(logs[0]).toContain("Profiles:");
  });

  it("rejects combining --json and --markdown with a non-zero exit", async () => {
    const { runtime, errors, exits } = createRuntime();
    await agentsCapabilitiesCommand(
      { json: true, markdown: true },
      runtime,
      {} as NodeJS.ProcessEnv,
    );
    expect(errors[0]).toContain("Cannot combine --json and --markdown");
    expect(exits).toContain(1);
    expect(mocks.requireValidConfigMock).not.toHaveBeenCalled();
  });

  it("returns quietly when config is invalid", async () => {
    mocks.requireValidConfigMock.mockResolvedValue(null);
    const { runtime, logs } = createRuntime();
    await agentsCapabilitiesCommand({ json: true }, runtime, {} as NodeJS.ProcessEnv);
    expect(logs).toHaveLength(0);
  });
});
