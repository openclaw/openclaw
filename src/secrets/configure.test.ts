/** Tests interactive and noninteractive secrets configure flows. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const confirmMock = vi.hoisted(() => vi.fn());
const selectMock = vi.hoisted(() => vi.fn());
const createSecretsConfigIOMock = vi.hoisted(() => vi.fn());
const loadPersistedAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const loadPersistedSharedAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const resolveSharedAuthStoreOwnershipMock = vi.hoisted(() => vi.fn());
const resolveSharedAuthStorePathMock = vi.hoisted(() => vi.fn());
const resolveAuthProfileDatabasePathMock = vi.hoisted(() => vi.fn());
const resolveAgentDirMock = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryMock = vi.hoisted(() => vi.fn());
const runSecretsApplyMock = vi.hoisted(() => vi.fn());
const tempDirs: string[] = [];

const textMock = vi.hoisted(() => vi.fn());

vi.mock("@clack/prompts", () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
  select: (...args: unknown[]) => selectMock(...args),
  text: (...args: unknown[]) => textMock(...args),
}));

vi.mock("./config-io.js", () => ({
  createSecretsConfigIO: (...args: unknown[]) => createSecretsConfigIOMock(...args),
}));

vi.mock("../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: (...args: unknown[]) => loadPersistedAuthProfileStoreMock(...args),
  loadPersistedSharedAuthProfileStore: (...args: unknown[]) =>
    loadPersistedSharedAuthProfileStoreMock(...args),
}));

vi.mock("../agents/auth-profiles/path-resolve.js", () => ({
  resolveSharedAuthStoreOwnership: (...args: unknown[]) =>
    resolveSharedAuthStoreOwnershipMock(...args),
  resolveSharedAuthStorePath: (...args: unknown[]) => resolveSharedAuthStorePathMock(...args),
  resolveSharedAuthPath: () => "/fake/shared-auth.json",
}));

vi.mock("../agents/auth-profiles/sqlite.js", () => ({
  resolveAuthProfileDatabasePath: (...args: unknown[]) =>
    resolveAuthProfileDatabasePathMock(...args),
}));

vi.mock("../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveAgentDir: (...args: unknown[]) => resolveAgentDirMock(...args),
  };
});

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: (...args: unknown[]) => loadPluginManifestRegistryMock(...args),
}));

vi.mock("./apply.js", () => ({
  runSecretsApply: (...args: unknown[]) => runSecretsApplyMock(...args),
}));

const { runSecretsConfigureInteractive } = await import("./configure.js");

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secrets-configure-"));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

describe("runSecretsConfigureInteractive", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    confirmMock.mockReset();
    selectMock.mockReset();
    createSecretsConfigIOMock.mockReset();
    loadPersistedAuthProfileStoreMock.mockReset();
    loadPersistedSharedAuthProfileStoreMock.mockReset();
    resolveSharedAuthStoreOwnershipMock.mockReset();
    resolveSharedAuthStoreOwnershipMock.mockReturnValue({ location: "agent-dir" });
    resolveSharedAuthStorePathMock.mockReset();
    resolveSharedAuthStorePathMock.mockReturnValue("/fake/shared-auth.sqlite");
    resolveAuthProfileDatabasePathMock.mockReset();
    resolveAuthProfileDatabasePathMock.mockReturnValue("/fake/agent-auth.sqlite");
    resolveAgentDirMock.mockReset();
    resolveAgentDirMock.mockImplementation((cfg, agentId, _env) => `/fake/agents/${agentId}/agent`);
    loadPluginManifestRegistryMock.mockReset();
    loadPluginManifestRegistryMock.mockReturnValue({ diagnostics: [], plugins: [] });
    runSecretsApplyMock.mockReset();
    runSecretsApplyMock.mockResolvedValue({
      changed: true,
      changedFiles: [],
      warningCount: 0,
      warnings: [],
      checks: { resolvabilityComplete: true },
      skippedExecRefs: 0,
    });
  });

  it("does not load auth-profiles when running providers-only", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    selectMock.mockResolvedValue("continue");
    createSecretsConfigIOMock.mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {},
          resolved: {},
        },
      }),
    });
    await expect(runSecretsConfigureInteractive({ providersOnly: true })).rejects.toThrow(
      "No secrets changes were selected.",
    );
    expect(loadPersistedAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("adds a plugin preset provider through providers-only configure", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    const pluginRoot = makeTempDir();
    const resolverPath = path.join(pluginRoot, "vault-secret-ref-resolver.js");
    fs.writeFileSync(resolverPath, "process.stdin.resume();\n");
    fs.chmodSync(resolverPath, 0o600);
    selectMock.mockResolvedValueOnce("preset");
    selectMock.mockResolvedValueOnce("vault:vault:vault");
    selectMock.mockResolvedValueOnce("continue");
    loadPluginManifestRegistryMock.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          id: "vault",
          name: "Vault",
          origin: "global",
          rootDir: pluginRoot,
          secretProviderIntegrations: {
            vault: {
              providerAlias: "vault",
              displayName: "HashiCorp Vault",
              source: "exec",
              command: "${node}",
              args: ["./vault-secret-ref-resolver.js"],
              passEnv: ["VAULT_ADDR", "VAULT_TOKEN"],
              timeoutMs: 5000,
            },
          },
        },
      ],
    });
    createSecretsConfigIOMock.mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {},
          resolved: {},
        },
      }),
    });

    const result = await runSecretsConfigureInteractive({
      providersOnly: true,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.plan.targets).toEqual([]);
    expect(result.plan.providerUpserts?.vault).toEqual({
      source: "exec",
      pluginIntegration: {
        pluginId: "vault",
        integrationId: "vault",
      },
    });
    expect(runSecretsApplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          providerUpserts: expect.objectContaining({
            vault: expect.objectContaining({ source: "exec" }),
          }),
        }),
        write: false,
        allowExec: false,
      }),
    );
    expect(loadPersistedAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("discovers auth-profile candidates from both shared and agent stores with local precedence", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    const sharedProfileId = "openai:shared";
    const localOnlyProfileId = "anthropic:local-only";
    const duplicateProfileId = "google:duplicate";

    resolveSharedAuthStoreOwnershipMock.mockReturnValue({ location: "state-db" });
    loadPersistedSharedAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        [sharedProfileId]: {
          type: "api_key",
          provider: "openai",
          key: "shared-key",
        },
        [duplicateProfileId]: {
          type: "api_key",
          provider: "google",
          key: "shared-dup-key",
        },
      },
    });
    loadPersistedAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        [localOnlyProfileId]: {
          type: "api_key",
          provider: "anthropic",
          key: "local-key",
        },
        [duplicateProfileId]: {
          type: "api_key",
          provider: "google",
          key: "local-dup-key",
        },
      },
    });

    type SelectOption = { value: string; hint?: string; label?: string };
    const capturedCandidates: SelectOption[] = [];
    textMock.mockReset();
    textMock.mockImplementation(async (params: { message?: string }) => {
      // Provider alias must be lowercase; secret id must be uppercase env var.
      if (params.message?.toLowerCase().includes("provider")) {
        return "openai";
      }
      return "OPENAI_API_KEY";
    });
    // Capture auth-profile candidates from the credential selection prompt, then
    // drive the rest of the flow (source → provider → id → confirm) to completion.
    selectMock.mockImplementation(async (params: { options: SelectOption[] }) => {
      const authProfileOptions = params.options.filter((opt) => opt.hint === "auth profile store");
      if (authProfileOptions.length > 0) {
        capturedCandidates.push(...authProfileOptions);
        return authProfileOptions[0]!.value;
      }
      // Secret source selection — pick the first option (usually "env").
      if (params.options.length > 0 && typeof params.options[0]?.value === "string") {
        return params.options[0]!.value;
      }
      return "__done__";
    });
    confirmMock.mockResolvedValue(false);

    createSecretsConfigIOMock.mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {
            secrets: {
              providers: {
                openai: { source: "env" },
              },
            },
          },
          resolved: {
            secrets: {
              providers: {
                openai: { source: "env" },
              },
            },
          },
        },
      }),
    });

    await runSecretsConfigureInteractive({
      providersOnly: false,
      skipProviderSetup: true,
      env: { OPENCLAW_STATE_DIR: "/fake", OPENAI_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    });

    // All three distinct profile ids should appear: shared-only, local-only, and duplicate.
    const allLabels = capturedCandidates.map((opt) => opt?.label ?? "").join("\n");
    expect(allLabels).toContain(sharedProfileId);
    expect(allLabels).toContain(localOnlyProfileId);
    expect(allLabels).toContain(duplicateProfileId);
    // The duplicate profile's key target should appear exactly once (local precedence,
    // not once per store). Each profile produces separate .key and .token candidates.
    const duplicateKeyCount = capturedCandidates.filter((opt) =>
      opt?.label?.includes(`${duplicateProfileId}.key`),
    ).length;
    expect(duplicateKeyCount).toBe(1);
    // Shared candidates must be labeled "shared", not "agent <id>", so an operator
    // is not misled into thinking they are changing an agent-local credential.
    const sharedLabels = capturedCandidates.filter((opt) => opt?.label?.includes(sharedProfileId));
    expect(sharedLabels.length).toBeGreaterThan(0);
    for (const opt of sharedLabels) {
      expect(opt?.label).toContain("shared");
      expect(opt?.label).not.toContain("agent");
    }
    // Agent-local candidates keep the "agent <id>" label.
    const localLabels = capturedCandidates.filter((opt) =>
      opt?.label?.includes(localOnlyProfileId),
    );
    expect(localLabels.length).toBeGreaterThan(0);
    for (const opt of localLabels) {
      expect(opt?.label).toContain("agent");
    }
  });

  it("drops shared candidates whose profile ID also exists in the agent store (mixed-type collision)", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });

    // Same profile ID as api_key in shared store and token in agent store.
    // Runtime drops the shared profile wholesale by ID, so configure must not
    // offer any shared candidate for that ID — the operator would migrate a
    // credential the selected agent does not use.
    const collisionProfileId = "openai:collision";
    const sharedOnlyProfileId = "anthropic:shared-only";

    resolveSharedAuthStoreOwnershipMock.mockReturnValue({ location: "state-db" });
    loadPersistedSharedAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        [collisionProfileId]: {
          type: "api_key",
          provider: "openai",
          key: "shared-key",
        },
        [sharedOnlyProfileId]: {
          type: "api_key",
          provider: "anthropic",
          key: "shared-only-key",
        },
      },
    });
    loadPersistedAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        [collisionProfileId]: {
          type: "token",
          provider: "openai",
          token: "local-token",
        },
      },
    });

    type SelectOption = { value: string; hint?: string; label?: string };
    const capturedCandidates: SelectOption[] = [];
    textMock.mockReset();
    textMock.mockImplementation(async (params: { message?: string }) => {
      if (params.message?.toLowerCase().includes("provider")) {
        return "openai";
      }
      return "OPENAI_API_KEY";
    });
    selectMock.mockImplementation(async (params: { options: SelectOption[] }) => {
      const authProfileOptions = params.options.filter((opt) => opt.hint === "auth profile store");
      if (authProfileOptions.length > 0) {
        capturedCandidates.push(...authProfileOptions);
        return authProfileOptions[0]!.value;
      }
      if (params.options.length > 0 && typeof params.options[0]?.value === "string") {
        return params.options[0]!.value;
      }
      return "__done__";
    });
    confirmMock.mockResolvedValue(false);

    createSecretsConfigIOMock.mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: {
          valid: true,
          config: {
            secrets: {
              providers: {
                openai: { source: "env" },
              },
            },
          },
          resolved: {
            secrets: {
              providers: {
                openai: { source: "env" },
              },
            },
          },
        },
      }),
    });

    await runSecretsConfigureInteractive({
      providersOnly: false,
      skipProviderSetup: true,
      env: { OPENCLAW_STATE_DIR: "/fake", OPENAI_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    });

    // The collision profile ID's shared api_key candidate must NOT appear —
    // the agent store has the same ID as a token, so runtime uses only local.
    const collisionSharedCandidates = capturedCandidates.filter(
      (opt) => opt?.label?.includes(collisionProfileId) && opt?.label?.includes("shared"),
    );
    expect(collisionSharedCandidates).toHaveLength(0);

    // The shared-only profile (no local override) must still appear as shared.
    const sharedOnlyCandidates = capturedCandidates.filter((opt) =>
      opt?.label?.includes(sharedOnlyProfileId),
    );
    expect(sharedOnlyCandidates.length).toBeGreaterThan(0);
    for (const opt of sharedOnlyCandidates) {
      expect(opt?.label).toContain("shared");
    }
  });
});

it("discovers shared auth-profile candidates under legacy-main ownership", async () => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });

  const sharedProfileId = "openai:legacy-shared";
  const localOnlyProfileId = "anthropic:child-local";

  // legacy-main ownership: shared store lives in the relocated shared-main
  // agent directory, not the state database. A non-main (child) agent
  // inherits profiles from that canonical shared store at runtime.
  resolveSharedAuthStoreOwnershipMock.mockReturnValue({ location: "legacy-main" });
  loadPersistedSharedAuthProfileStoreMock.mockReturnValue({
    version: 1,
    profiles: {
      [sharedProfileId]: {
        type: "api_key",
        provider: "openai",
        key: "legacy-shared-key",
      },
    },
  });
  loadPersistedAuthProfileStoreMock.mockReturnValue({
    version: 1,
    profiles: {
      [localOnlyProfileId]: {
        type: "api_key",
        provider: "anthropic",
        key: "child-local-key",
      },
    },
  });
  // Distinct paths so the child agent's local store is not deduped away.
  resolveSharedAuthStorePathMock.mockReturnValue("/fake/legacy-shared-main.sqlite");
  resolveAuthProfileDatabasePathMock.mockReturnValue("/fake/child-agent.sqlite");

  type SelectOption = { value: string; hint?: string; label?: string };
  const capturedCandidates: SelectOption[] = [];
  textMock.mockReset();
  textMock.mockImplementation(async (params: { message?: string }) => {
    if (params.message?.toLowerCase().includes("provider")) {
      return "openai";
    }
    return "OPENAI_API_KEY";
  });
  selectMock.mockImplementation(async (params: { options: SelectOption[] }) => {
    const authProfileOptions = params.options.filter((opt) => opt.hint === "auth profile store");
    if (authProfileOptions.length > 0) {
      capturedCandidates.push(...authProfileOptions);
      return authProfileOptions[0]!.value;
    }
    if (params.options.length > 0 && typeof params.options[0]?.value === "string") {
      return params.options[0]!.value;
    }
    return "__done__";
  });
  confirmMock.mockResolvedValue(false);

  createSecretsConfigIOMock.mockReturnValue({
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: {
        valid: true,
        config: {
          secrets: {
            providers: {
              openai: { source: "env" },
            },
          },
        },
        resolved: {
          secrets: {
            providers: {
              openai: { source: "env" },
            },
          },
        },
      },
    }),
  });

  await runSecretsConfigureInteractive({
    providersOnly: false,
    skipProviderSetup: true,
    env: { OPENCLAW_STATE_DIR: "/fake", OPENAI_API_KEY: "test-key" } as NodeJS.ProcessEnv,
  });

  // The shared profile from the relocated legacy shared-main store must be
  // discoverable even though ownership is legacy-main (not state-db).
  const allLabels = capturedCandidates.map((opt) => opt?.label ?? "").join("\n");
  expect(allLabels).toContain(sharedProfileId);
  expect(allLabels).toContain(localOnlyProfileId);
  // Shared candidate labeled "shared", not "agent".
  const sharedLabels = capturedCandidates.filter((opt) => opt?.label?.includes(sharedProfileId));
  expect(sharedLabels.length).toBeGreaterThan(0);
  for (const opt of sharedLabels) {
    expect(opt?.label).toContain("shared");
    expect(opt?.label).not.toContain("agent");
  }
});

it("dedupes the agent store when it resolves to the same database as the shared store", async () => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });

  const sharedProfileId = "openai:shared-only";

  resolveSharedAuthStoreOwnershipMock.mockReturnValue({ location: "legacy-main" });
  loadPersistedSharedAuthProfileStoreMock.mockReturnValue({
    version: 1,
    profiles: {
      [sharedProfileId]: {
        type: "api_key",
        provider: "openai",
        key: "shared-key",
      },
    },
  });
  // The main agent's local store resolves to the same database as the shared
  // store (legacy-main: shared store IS the main agent's store). The agent
  // scope should be skipped to avoid offering duplicate candidates.
  resolveSharedAuthStorePathMock.mockReturnValue("/fake/main-agent.sqlite");
  resolveAuthProfileDatabasePathMock.mockReturnValue("/fake/main-agent.sqlite");

  type SelectOption = { value: string; hint?: string; label?: string };
  const capturedCandidates: SelectOption[] = [];
  textMock.mockReset();
  textMock.mockImplementation(async (params: { message?: string }) => {
    if (params.message?.toLowerCase().includes("provider")) {
      return "openai";
    }
    return "OPENAI_API_KEY";
  });
  selectMock.mockImplementation(async (params: { options: SelectOption[] }) => {
    const authProfileOptions = params.options.filter((opt) => opt.hint === "auth profile store");
    if (authProfileOptions.length > 0) {
      capturedCandidates.push(...authProfileOptions);
      return authProfileOptions[0]!.value;
    }
    if (params.options.length > 0 && typeof params.options[0]?.value === "string") {
      return params.options[0]!.value;
    }
    return "__done__";
  });
  confirmMock.mockResolvedValue(false);

  createSecretsConfigIOMock.mockReturnValue({
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: {
        valid: true,
        config: {
          secrets: {
            providers: {
              openai: { source: "env" },
            },
          },
        },
        resolved: {
          secrets: {
            providers: {
              openai: { source: "env" },
            },
          },
        },
      },
    }),
  });

  await runSecretsConfigureInteractive({
    providersOnly: false,
    skipProviderSetup: true,
    env: { OPENCLAW_STATE_DIR: "/fake", OPENAI_API_KEY: "test-key" } as NodeJS.ProcessEnv,
  });

  // The shared profile appears exactly once (not duplicated from an agent
  // scope that resolves to the same database).
  const sharedCandidateCount = capturedCandidates.filter((opt) =>
    opt?.label?.includes(`${sharedProfileId}.key`),
  ).length;
  expect(sharedCandidateCount).toBe(1);
});

it("resolves the agent store from the injected environment, not ambient process.env", async () => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });

  const injectedEnv = {
    OPENCLAW_STATE_DIR: "/fake/injected-root",
    OPENAI_API_KEY: "test-key",
  } as NodeJS.ProcessEnv;
  const sharedProfileId = "openai:shared-injected";
  resolveSharedAuthStoreOwnershipMock.mockReturnValue({ location: "state-db" });
  loadPersistedSharedAuthProfileStoreMock.mockReturnValue({
    version: 1,
    profiles: {
      [sharedProfileId]: {
        type: "api_key",
        provider: "openai",
        key: "shared-key",
      },
    },
  });
  // Distinct shared/agent paths so the agent scope is not deduped away.
  resolveSharedAuthStorePathMock.mockReturnValue("/fake/injected-root/shared.sqlite");
  resolveAuthProfileDatabasePathMock.mockReturnValue("/fake/injected-root/agent.sqlite");
  // Capture the env argument passed to resolveAgentDir; it must be the
  // injected env, not ambient process.env.
  resolveAgentDirMock.mockImplementation(
    (cfg: unknown, agentId: string, env?: NodeJS.ProcessEnv) => {
      return path.join(env?.OPENCLAW_STATE_DIR ?? "/AMBIENT", "agents", agentId, "agent");
    },
  );

  type SelectOption = { value: string; hint?: string; label?: string };
  textMock.mockReset();
  textMock.mockImplementation(async (params: { message?: string }) => {
    if (params.message?.toLowerCase().includes("provider")) {
      return "openai";
    }
    return "OPENAI_API_KEY";
  });
  selectMock.mockImplementation(async (params: { options: SelectOption[] }) => {
    const authProfileOptions = params.options.filter((opt) => opt.hint === "auth profile store");
    if (authProfileOptions.length > 0) {
      return authProfileOptions[0]!.value;
    }
    if (params.options.length > 0 && typeof params.options[0]?.value === "string") {
      return params.options[0]!.value;
    }
    return "__done__";
  });
  confirmMock.mockResolvedValue(false);

  createSecretsConfigIOMock.mockReturnValue({
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: {
        valid: true,
        config: {
          secrets: {
            providers: {
              openai: { source: "env" },
            },
          },
        },
        resolved: {
          secrets: {
            providers: {
              openai: { source: "env" },
            },
          },
        },
      },
    }),
  });

  await runSecretsConfigureInteractive({
    providersOnly: false,
    skipProviderSetup: true,
    env: injectedEnv,
  });

  // resolveAgentDir must have received the injected env (third argument)
  // in at least one call, proving agent-store discovery uses the same
  // caller-provided root as shared-store discovery.
  const callWithInjectedEnv = resolveAgentDirMock.mock.calls.find(
    (call) => call[2] === injectedEnv,
  );
  expect(callWithInjectedEnv).toBeDefined();
  // No call should fall back to ambient process.env as the env argument.
  const ambientCalls = resolveAgentDirMock.mock.calls.filter(
    (call) => call[2] === undefined || call[2] === process.env,
  );
  expect(ambientCalls).toHaveLength(0);
});
