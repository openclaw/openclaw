/** Tests interactive and noninteractive secrets configure flows. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthProfileStoreFixture } from "../agents/auth-profiles/credential-fixtures.test-support.js";

const confirmMock = vi.hoisted(() => vi.fn());
const selectMock = vi.hoisted(() => vi.fn());
const createSecretsConfigIOMock = vi.hoisted(() => vi.fn());
const loadPersistedAuthProfileStoreMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryMock = vi.hoisted(() => vi.fn());
const runSecretsApplyMock = vi.hoisted(() => vi.fn());
const tempDirs: string[] = [];

vi.mock("@clack/prompts", () => ({
  confirm: confirmMock,
  select: selectMock,
  text: vi.fn(),
  log: { warn: logMock },
}));

vi.mock("./config-io.js", () => ({ createSecretsConfigIO: createSecretsConfigIOMock }));

vi.mock("../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: loadPersistedAuthProfileStoreMock,
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: loadPluginManifestRegistryMock,
}));

vi.mock("./apply.js", () => ({ runSecretsApply: runSecretsApplyMock }));

import { noteCommittedSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";

const { runSecretsConfigureInteractive } = await import("./configure.js");

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secrets-configure-"));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

// Write the canonical raw row so plaintext beside keyRef survives normalization.
function writeSharedAuthProfileStoreRaw(env: NodeJS.ProcessEnv, payload: unknown): void {
  noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
  const { db } = openOpenClawStateDatabase({ env });
  try {
    db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
    ).run("authProfiles.store", JSON.stringify(payload));
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
}

function profile(fields: Record<string, unknown>) {
  return { type: "api_key", provider: "openai", ...fields };
}

async function configureEmptyAgent(profiles?: Record<string, unknown>): Promise<void> {
  const env = { OPENCLAW_STATE_DIR: makeTempDir() };
  if (profiles) {
    writeSharedAuthProfileStoreRaw(env, createAuthProfileStoreFixture(profiles));
  }
  loadPersistedAuthProfileStoreMock.mockReturnValue(createAuthProfileStoreFixture({}));
  await expect(
    runSecretsConfigureInteractive({ providersOnly: false, skipProviderSetup: true, env }),
  ).rejects.toThrow("No configurable secret-bearing fields found for this agent scope.");
}

const keyRef = { source: "env", provider: "default", id: "OPENAI_API_KEY" };

describe("runSecretsConfigureInteractive", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    confirmMock.mockReset();
    selectMock.mockReset();
    createSecretsConfigIOMock.mockReset().mockReturnValue({
      readConfigFileSnapshotForWrite: async () => ({
        snapshot: { valid: true, config: {}, resolved: {} },
      }),
    });
    loadPersistedAuthProfileStoreMock.mockReset();
    logMock.mockReset();
    loadPluginManifestRegistryMock.mockReset().mockReturnValue({ diagnostics: [], plugins: [] });
    runSecretsApplyMock.mockReset().mockResolvedValue({
      changed: true,
      changedFiles: [],
      warningCount: 0,
      warnings: [],
      checks: { resolvabilityComplete: true },
      skippedExecRefs: 0,
    });
  });

  it("does not load auth-profiles when running providers-only", async () => {
    selectMock.mockResolvedValue("continue");
    await expect(runSecretsConfigureInteractive({ providersOnly: true })).rejects.toThrow(
      "No secrets changes were selected.",
    );
    expect(loadPersistedAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("adds a plugin preset provider through providers-only configure", async () => {
    const pluginRoot = makeTempDir();
    const resolverPath = path.join(pluginRoot, "vault-secret-ref-resolver.js");
    fs.writeFileSync(resolverPath, "process.stdin.resume();\n");
    fs.chmodSync(resolverPath, 0o600);
    selectMock.mockResolvedValueOnce("preset");
    selectMock.mockImplementationOnce(({ options }) => options[0].value);
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

    const vault = {
      source: "exec",
      pluginIntegration: { pluginId: "vault", integrationId: "vault" },
    };
    const result = await runSecretsConfigureInteractive({ providersOnly: true, env: {} });
    expect(result.plan.targets).toEqual([]);
    expect(result.plan.providerUpserts?.vault).toEqual(vault);
    expect(runSecretsApplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({
          providerUpserts: expect.objectContaining({ vault }),
        }),
        write: false,
        allowExec: false,
      }),
    );
    expect(loadPersistedAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("warns when the shared auth-profile store carries plaintext credentials", async () => {
    // Warn before the empty-candidate guard, including raw plaintext beside keyRef.
    await configureEmptyAgent({
      "openai:shared": profile({ key: "sk-shared-plaintext" }), // pragma: allowlist secret
      "openai:plaintext-with-ref": profile({
        key: "sk-leftover-plaintext", // pragma: allowlist secret
        keyRef,
      }),
    });

    expect(logMock).toHaveBeenCalledTimes(1);
    const message = String(logMock.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("Shared auth-profile store");
    expect(message).toContain("2 plaintext credential(s)");
    expect(message).toContain("cannot migrate shared credentials");
  });

  it("does not warn when shared profiles only carry SecretRef values", async () => {
    await configureEmptyAgent({
      "openai:ref": profile({ keyRef }),
      "openai:dollar": profile({ key: "$OPENAI_API_KEY" }), // pragma: allowlist secret
      "openai:braced": profile({ key: "${OPENAI_API_KEY}" }), // pragma: allowlist secret
    });
    expect(logMock).not.toHaveBeenCalled();
  });

  it("does not warn when the shared auth-profile store is missing", async () => {
    await configureEmptyAgent();
    expect(logMock).not.toHaveBeenCalled();
  });
});
