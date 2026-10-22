/** Tests secrets apply dry-run/write behavior across config and auth stores. */
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerResolvedAgentDir } from "../agents/agent-dir-registry.js";
import { createAuthProfileStoreFixture } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { getRuntimeAuthProfileStoreCredentialMutationToken } from "../agents/auth-profiles/mutation-lineage.js";
import { noteCommittedSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { failNextRuntimeAuthSnapshotPublication } from "../agents/auth-profiles/profile-mutations.test-support.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import {
  readPersistedAuthProfileStateRaw,
  readPersistedAuthProfileStoreRaw,
  readPersistedSharedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStateRaw,
} from "../agents/auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store-runtime.js";
import { getRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createApplyFixture,
  createOpenAiProviderConfig,
  mutateAuthStoreBeforeNextPublication,
  OPENAI_API_KEY_ENV_REF,
  readAuthStore,
  seedDefaultApplyFixture,
  writeJsonFile,
  type ApplyFixture,
} from "./apply.test-support.js";
import type { SecretsApplyPlan } from "./plan.js";

const { prepareSecretsRuntimeSnapshotMock } = vi.hoisted(() => ({
  prepareSecretsRuntimeSnapshotMock: vi.fn(
    async (_params: Parameters<typeof import("./runtime.js").prepareSecretsRuntimeSnapshot>[0]) =>
      undefined,
  ),
}));

// mock-isolation: Exercise apply publication without installing a live secrets runtime.
vi.mock("./runtime.js", () => ({
  clearSecretsRuntimeSnapshot: vi.fn(),
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
}));

let runSecretsApply: typeof import("./apply.js").runSecretsApply;
let applyTesting: typeof import("./apply.js").testing;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function stripVolatileConfigMeta(input: string): Record<string, unknown> {
  const parsed = JSON.parse(input) as Record<string, unknown> & { meta?: Record<string, unknown> };
  if (parsed.meta) {
    delete parsed.meta.lastTouchedAt;
  }
  return parsed;
}

function createPlan(
  params: Pick<SecretsApplyPlan, "targets" | "options" | "providerUpserts" | "providerDeletes">,
): SecretsApplyPlan {
  return {
    version: 1,
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: "manual",
    ...params,
  };
}

const targetPlan = (...targets: SecretsApplyPlan["targets"]) =>
  createPlan({ targets, options: NO_SCRUB });

const NO_SCRUB = {
  scrubEnv: false,
  scrubAuthProfilesForProviderTargets: false,
  scrubLegacyAuthJson: false,
};

type Target = SecretsApplyPlan["targets"][number];
function createAuthTarget(
  agentId = "main",
  profileId = "openai:default",
  authProfileProvider?: string,
): Target {
  return {
    type: "auth-profiles.api_key.key",
    path: `profiles.${profileId}.key`,
    pathSegments: ["profiles", profileId, "key"],
    agentId,
    ref: OPENAI_API_KEY_ENV_REF,
    ...(authProfileProvider ? { authProfileProvider } : {}),
  };
}
const createOpenAiProviderTarget = (overrides: Partial<Target> = {}): Target => ({
  type: "models.providers.apiKey",
  path: "models.providers.openai.apiKey",
  providerId: "openai",
  ref: OPENAI_API_KEY_ENV_REF,
  ...overrides,
});

function createOpenAiExecProviderPlan(): SecretsApplyPlan {
  return targetPlan(
    createOpenAiProviderTarget({
      ref: { source: "exec", provider: "execmain", id: "providers/openai/apiKey" },
    }),
  );
}

function createPluginProviderPlan(): SecretsApplyPlan {
  return createPlan({
    providerUpserts: {
      vault: {
        source: "exec",
        pluginIntegration: { pluginId: "vault", integrationId: "vault" },
      },
    },
    targets: [],
  });
}

async function writeOpenAiExecResolverConfig(fixture: ApplyFixture, execLogPath: string) {
  const execScriptPath = path.join(fixture.rootDir, "resolver.sh");
  await fs.writeFile(
    execScriptPath,
    [
      "#!/bin/sh",
      `printf 'x\\n' >> ${JSON.stringify(execLogPath)}`,
      "cat >/dev/null",
      'printf \'{"protocolVersion":1,"values":{"providers/openai/apiKey":"sk-openai-exec"}}\'', // pragma: allowlist secret
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );

  await writeJsonFile(fixture.configPath, {
    secrets: {
      providers: {
        execmain: {
          source: "exec",
          command: execScriptPath,
          jsonOnly: true,
          timeoutMs: 20_000,
          noOutputTimeoutMs: 10_000,
        },
      },
    },
    models: { providers: { openai: createOpenAiProviderConfig() } },
  });
}

const SCRUB_OPTIONS = {
  scrubEnv: true,
  scrubAuthProfilesForProviderTargets: true,
  scrubLegacyAuthJson: true,
};

describe("secrets apply", () => {
  let fixture: ApplyFixture;

  const apply = (plan: SecretsApplyPlan, write = true, allowExec = false) =>
    runSecretsApply({ plan, env: fixture.env, write, allowExec });
  const project = (plan: SecretsApplyPlan) =>
    applyTesting.projectConfigForTest({ plan, env: fixture.env });
  const scrubPlan = () =>
    createPlan({
      targets: [createOpenAiProviderTarget()],
      options: SCRUB_OPTIONS,
    });
  const writeConfig = (config: unknown) => writeJsonFile(fixture.configPath, config);
  const writeStore = (store: unknown) => writeJsonFile(fixture.authStorePath, store);
  const writeProfiles = (profiles: Record<string, unknown>) =>
    writeStore(createAuthProfileStoreFixture(profiles));
  const readJsonFile = async (filePath: string) =>
    JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
  const readText = (filePath: string) => fs.readFile(filePath, "utf8");
  const apiKey = (key: string) => ({ type: "api_key" as const, provider: "openai", key });
  const persisted = (agentDir = fixture.agentDir) => ({
    credentials: readPersistedAuthProfileStoreRaw(agentDir),
    state: readPersistedAuthProfileStateRaw(agentDir),
  });
  const fileSnapshot = async () => ({
    config: await readText(fixture.configPath),
    authJson: await readText(fixture.authJsonPath),
    env: await readText(fixture.envPath),
  });
  const snapshot = async () => ({ ...persisted(), ...(await fileSnapshot()) });
  const publishStore = (agentDir: string) =>
    replaceRuntimeAuthProfileStoreSnapshots([
      { agentDir, store: loadAuthProfileStoreWithoutExternalProfiles(agentDir) },
    ]);
  const writeAgentStore = async (agentDir: string, profiles: AuthProfileStore["profiles"]) => {
    const store = createAuthProfileStoreFixture(profiles);
    await writeJsonFile(resolveAuthProfileDatabasePath(agentDir), store);
    return store;
  };

  async function configureAgents(firstAgentDir: string, secondAgentDir: string) {
    const entries = { first: { agentDir: firstAgentDir }, second: { agentDir: secondAgentDir } };
    await writeConfig({ agents: { ownership: "explicit", entries } });
  }

  function failSecondAgentWrite(secondAgentDir: string, message: string) {
    openOpenClawAgentDatabase({
      agentId: "second",
      path: resolveAuthProfileDatabasePath(secondAgentDir),
    }).db.exec(`
      CREATE TRIGGER reject_second_auth_store_insert
      BEFORE INSERT ON auth_profile_store
      BEGIN
        SELECT RAISE(ABORT, '${message}');
      END;
    `);
    return targetPlan(
      createAuthTarget("first", "openai:default", "openai"),
      createAuthTarget("second", "openai:default", "openai"),
    );
  }

  beforeAll(async () => {
    ({ testing: applyTesting, runSecretsApply } = await import("./apply.js"));
  });

  beforeEach(async () => {
    prepareSecretsRuntimeSnapshotMock.mockClear();
    fixture = await createApplyFixture(tempDirs.make("openclaw-secrets-apply-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", fixture.stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", fixture.configPath);
    await seedDefaultApplyFixture(fixture);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    clearRuntimeAuthProfileStoreSnapshots();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it("preflights and applies one-way scrub without plaintext backups", async () => {
    await fs.appendFile(
      fixture.envPath,
      "GH_TOKEN=sk-openai-plaintext\nGITHUB_TOKEN=unmigrated-github-token\n", // pragma: allowlist secret
    );
    fixture.env.OPENAI_KEY_NEXT = fixture.env.OPENAI_API_KEY;
    const plan = createPlan({
      targets: [
        createOpenAiProviderTarget(),
        { ...createAuthTarget(), ref: { ...OPENAI_API_KEY_ENV_REF, id: "OPENAI_KEY_NEXT" } },
      ],
      options: SCRUB_OPTIONS,
    });
    const before = await snapshot();

    const dryRun = await apply(plan, false);
    expect(dryRun).toMatchObject({
      mode: "dry-run",
      changed: true,
      skippedExecRefs: 0,
      checks: { resolvabilityComplete: true },
    });
    expect(await snapshot()).toEqual(before);

    prepareSecretsRuntimeSnapshotMock.mockImplementationOnce(async ({ loadAuthStore }) => {
      const store = await expectDefined(
        loadAuthStore,
        "preflight auth-store loader",
      )(fixture.agentDir);
      const profile = store.profiles["openai:default"];
      if (profile?.type !== "api_key" || !profile.keyRef) {
        throw new Error("expected the projected auth-profile SecretRef");
      }
      expect(profile.keyRef.id).toBe("OPENAI_KEY_NEXT");
      profile.keyRef.id = "PREFLIGHT_ONLY";
      return undefined;
    });

    expect(await apply(plan)).toMatchObject({ mode: "write", changed: true });
    expect(prepareSecretsRuntimeSnapshotMock).toHaveBeenCalledTimes(1);

    expect(await readJsonFile(fixture.configPath)).toHaveProperty(
      "models.providers.openai.apiKey",
      OPENAI_API_KEY_ENV_REF,
    );

    const profile = (await readAuthStore(fixture)).profiles["openai:default"];
    expect(profile).toEqual({
      type: "api_key",
      provider: "openai",
      keyRef: { ...OPENAI_API_KEY_ENV_REF, id: "OPENAI_KEY_NEXT" },
    });

    expect((await readJsonFile(fixture.authJsonPath)).openai).toBeDefined();

    expect(await readText(fixture.envPath)).toBe(
      "UNRELATED=value\nGITHUB_TOKEN=unmigrated-github-token\n",
    );
  });

  it.each([
    [
      "preserves tokenRef",
      "token",
      { token: "sk-token-plaintext", tokenRef: OPENAI_API_KEY_ENV_REF }, // pragma: allowlist secret
      { tokenRef: OPENAI_API_KEY_ENV_REF },
    ],
    [
      "removes malformed ref residue",
      "api_key",
      { key: "sk-openai-plaintext", keyRef: "secretref-managed" }, // pragma: allowlist secret
      {},
    ],
  ] as const)("provider scrub %s", async (_name, type, fields, remaining) => {
    await writeProfiles({ "openai:default": { type, provider: "openai", ...fields } });
    await apply(scrubPlan());
    expect((await readAuthStore(fixture)).profiles["openai:default"]).toEqual({
      type,
      provider: "openai",
      ...remaining,
    });
  });

  it("keeps shared and implicit agent writes inside the explicitly routed state root", async () => {
    const ambientStateDir = path.join(fixture.rootDir, "ambient-state");
    const ambientMainDir = path.join(ambientStateDir, "agents", "main", "agent");
    const ambientOpsDir = path.join(ambientStateDir, "agents", "ops", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", ambientStateDir);
    for (const [agentDir, suffix] of [
      [ambientMainDir, "shared"],
      [ambientOpsDir, "ops"],
    ] as const) {
      await writeAgentStore(agentDir, {
        [`openai:ambient-${suffix}`]: apiKey(`sk-ambient-${suffix}`),
      });
    }
    await writeConfig({
      agents: { entries: { ops: {} } },
      models: { providers: { openai: createOpenAiProviderConfig() } },
    });
    const insertState = openOpenClawStateDatabase({ env: fixture.env }).db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
    );
    insertState.run("auth.sharedStore", JSON.stringify({ location: "state-db" }));
    insertState.run(
      "authProfiles.store",
      JSON.stringify(
        createAuthProfileStoreFixture({
          "openai:target-shared": apiKey("sk-target-shared"),
        }),
      ),
    );
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, fixture.env);

    await apply(scrubPlan());

    expect(readPersistedSharedAuthProfileStoreRaw(fixture.env)).toEqual({
      version: 1,
      profiles: {
        "openai:target-shared": { type: "api_key", provider: "openai" },
      },
    });
    expect(readPersistedAuthProfileStoreRaw(ambientMainDir)).toMatchObject({
      profiles: { "openai:ambient-shared": { key: "sk-ambient-shared" } },
    });
    expect(readPersistedAuthProfileStoreRaw(ambientOpsDir)).toMatchObject({
      profiles: { "openai:ambient-ops": { key: "sk-ambient-ops" } },
    });
    expect(
      readPersistedAuthProfileStoreRaw(path.join(fixture.stateDir, "agents", "ops", "agent")),
    ).toBeNull();
  });

  it("skips exec SecretRef checks during dry-run unless explicitly allowed", async () => {
    if (process.platform === "win32") {
      return;
    }
    const execLogPath = path.join(fixture.rootDir, "exec-calls.log");
    await writeOpenAiExecResolverConfig(fixture, execLogPath);

    const plan = createOpenAiExecProviderPlan();
    const dryRunSkipped = await apply(plan, false);
    expect(dryRunSkipped).toMatchObject({
      mode: "dry-run",
      skippedExecRefs: 1,
      checks: { resolvabilityComplete: false },
    });
    await expect(fs.stat(execLogPath)).rejects.toMatchObject({ code: "ENOENT" });

    const dryRunAllowed = await apply(plan, false, true);
    expect(dryRunAllowed).toMatchObject({ mode: "dry-run", skippedExecRefs: 0 });
    const callLog = await readText(execLogPath);
    expect(callLog.split("\n").some((line) => line.trim().length > 0)).toBe(true);
  });

  it.each([
    ["refs", createOpenAiExecProviderPlan()],
    [
      "provider upserts",
      createPlan({
        targets: [createOpenAiProviderTarget()],
        providerUpserts: { execmain: { source: "exec", command: "/bin/echo", args: ["ok"] } },
        options: NO_SCRUB,
      }),
    ],
  ] as const)("rejects write mode with exec %s unless allowExec is set", async (_kind, plan) => {
    await expect(apply(plan)).rejects.toThrow(
      "Plan contains exec SecretRefs/providers. Re-run with --allow-exec.",
    );
  });

  it("preserves relocated shared inheritance when applying an agent SecretRef", async () => {
    const sharedDir = path.join(fixture.rootDir, "relocated-shared");
    const agentDir = path.join(fixture.rootDir, "ops-agent");
    fixture.env.OPENCLAW_AGENT_DIR = sharedDir;
    vi.stubEnv("OPENCLAW_STATE_DIR", fixture.stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", sharedDir);
    noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" }, fixture.env);
    registerResolvedAgentDir({ agentId: "ops", agentDir });
    const shared = await writeAgentStore(sharedDir, {
      "openai:inherited": apiKey("fake-inherited"),
    });
    await writeAgentStore(agentDir, {
      "openai:local": apiKey("fake-local"),
    });
    await writeConfig({ agents: { entries: { ops: { agentDir } } } });
    publishStore(agentDir);
    expect(getRuntimeAuthProfileStoreSnapshot(agentDir)?.profiles["openai:inherited"]).toEqual(
      shared.profiles["openai:inherited"],
    );
    await apply(targetPlan(createAuthTarget("ops", "openai:local")));
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toMatchObject({
      profiles: { "openai:local": { keyRef: OPENAI_API_KEY_ENV_REF } },
    });
    expect(readPersistedAuthProfileStoreRaw(sharedDir)).toEqual(shared);
    const runtime = getRuntimeAuthProfileStoreSnapshot(agentDir);
    expect(runtime?.profiles["openai:inherited"]).toEqual(shared.profiles["openai:inherited"]);
    expect(runtime?.profiles["openai:default"]).toBeUndefined();
  });

  it("rolls back committed auth rows when runtime publication fails", async () => {
    await writeProfiles({ "openai:default": apiKey("fake") });
    const before = persisted();
    const plan = targetPlan(createAuthTarget("main", "openai:default", "openai"));
    publishStore(fixture.agentDir);
    const publicationFailure = failNextRuntimeAuthSnapshotPublication();

    await expect(apply(plan)).rejects.toThrow("auth profile runtime publication failed");

    expect(publicationFailure).toHaveBeenCalledOnce();
    expect(persisted()).toEqual(before);
  });

  it("atomically deletes a newly created auth store when a later auth write fails", async () => {
    const firstAgentDir = path.join(fixture.rootDir, "custom-first-agent");
    const secondAgentDir = path.join(fixture.rootDir, "custom-second-agent");
    const firstStorePath = resolveAuthProfileDatabasePath(firstAgentDir);
    await configureAgents(firstAgentDir, secondAgentDir);
    const firstState = { version: 1 as const, order: { openai: ["openai:preexisting"] } };
    registerResolvedAgentDir({ agentId: "first", agentDir: firstAgentDir, env: fixture.env });
    const firstDatabase = openOpenClawAgentDatabase({
      agentId: "first",
      path: firstStorePath,
    });
    writePersistedAuthProfileStateRaw(firstState, firstAgentDir, firstDatabase);
    replaceRuntimeAuthProfileStoreSnapshots([
      { agentDir: firstAgentDir, store: { profiles: {}, ...firstState } },
    ]);
    const firstMutationRevision =
      getRuntimeAuthProfileStoreCredentialMutationToken(firstAgentDir).revision;
    const plan = failSecondAgentWrite(secondAgentDir, "injected second auth store failure");

    await expect(apply(plan)).rejects.toThrow("injected second auth store failure");

    expect(await fs.stat(firstStorePath)).toBeDefined();
    expect(readPersistedAuthProfileStoreRaw(firstAgentDir)).toBeNull();
    expect(readPersistedAuthProfileStateRaw(firstAgentDir)).toEqual(firstState);
    expect(getRuntimeAuthProfileStoreSnapshot(firstAgentDir)).toMatchObject({
      profiles: {},
      order: firstState.order,
    });
    expect(
      getRuntimeAuthProfileStoreCredentialMutationToken(firstAgentDir).revision,
    ).toBeGreaterThan(firstMutationRevision);
  });

  it.each(["credentials", "state"] as const)(
    "preserves a concurrent auth %s write when a later auth store write fails",
    async (concurrentMutation) => {
      const firstAgentDir = path.join(fixture.rootDir, `concurrent-${concurrentMutation}-agent`);
      const secondAgentDir = path.join(fixture.rootDir, "concurrent-failing-agent");
      registerResolvedAgentDir({ agentId: "first", agentDir: firstAgentDir });
      registerResolvedAgentDir({ agentId: "second", agentDir: secondAgentDir });
      await configureAgents(firstAgentDir, secondAgentDir);
      const initialStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:default": apiKey("sk-before-apply"), // pragma: allowlist secret
          "openai:oauth": {
            type: "oauth",
            provider: "openai",
            access: "oauth-before-apply",
            refresh: "refresh-before-apply",
            expires: Date.now() + 60_000,
          },
        },
        order: { openai: ["openai:default"] },
      };
      saveAuthProfileStore(initialStore, firstAgentDir, { syncExternalCli: false });
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: firstAgentDir, store: initialStore }]);
      const plan = failSecondAgentWrite(
        secondAgentDir,
        "injected concurrent second auth store failure",
      );

      mutateAuthStoreBeforeNextPublication(firstAgentDir, concurrentMutation);

      await expect(apply(plan)).rejects.toThrow("injected concurrent second auth store failure");

      const persistedStore = await readAuthStore({ ...fixture, agentDir: firstAgentDir });
      const runtime = getRuntimeAuthProfileStoreSnapshot(firstAgentDir);
      for (const store of [persistedStore, runtime]) {
        if (concurrentMutation === "credentials") {
          expect(store?.profiles["openai:oauth"]).toMatchObject({
            access: "oauth-concurrent",
            refresh: "refresh-concurrent",
          });
        } else {
          expect(store?.profiles["openai:default"]).toMatchObject({ key: "sk-before-apply" });
          expect(store?.order?.openai).toEqual(["openai:oauth", "openai:default"]);
        }
      }
    },
  );

  it("preserves unrelated oauth profiles while applying auth-profile key ref targets", async () => {
    await writeStore({
      version: 1,
      profiles: {
        "openai:static": apiKey("sk-openai-static"), // pragma: allowlist secret
        "openai:sidecar": {
          type: "oauth",
          provider: "openai",
          oauthRef: { id: "codex-sidecar-ref", provider: "openai" },
          email: "codex@example.invalid",
        },
        "anthropic:claude-cli": { provider: "claude-cli", type: "oauth" },
      },
      order: {
        openai: ["openai:sidecar", "openai:static"],
        "claude-cli": ["anthropic:claude-cli"],
      },
      lastGood: {
        openai: "openai:sidecar",
        "claude-cli": "anthropic:claude-cli",
      },
    });
    const plan = targetPlan(createAuthTarget("main", "openai:static"));

    expect((await apply(plan)).changed).toBe(true);
    const store = await readAuthStore(fixture);
    expect(store).toMatchObject({
      order: { openai: ["openai:sidecar", "openai:static"] },
      lastGood: { "claude-cli": "anthropic:claude-cli" },
    });
    expect(store.profiles).toEqual({
      "openai:static": { type: "api_key", provider: "openai", keyRef: OPENAI_API_KEY_ENV_REF },
      "openai:sidecar": expect.objectContaining({
        type: "oauth",
        provider: "openai",
        email: "codex@example.invalid",
      }),
      "anthropic:claude-cli": { provider: "claude-cli", type: "oauth" },
    });
  });

  it("is idempotent on repeated write applies", async () => {
    const plan = scrubPlan();

    const first = await apply(plan);
    expect(first.changed).toBe(true);
    const before = await fileSnapshot();
    const storeBefore = JSON.stringify(await readAuthStore(fixture));
    await fs.chmod(fixture.configPath, 0o400);
    expect((await apply(plan)).mode).toBe("write");
    const after = await fileSnapshot();
    expect({ ...after, config: stripVolatileConfigMeta(after.config) }).toEqual({
      ...before,
      config: stripVolatileConfigMeta(before.config),
    });
    expect(JSON.stringify(await readAuthStore(fixture))).toBe(storeBefore);
  });

  it("rejects prototype-like plan target paths", async () => {
    const target = {
      type: "skills.entries.apiKey",
      path: "skills.entries.__proto__.apiKey",
      pathSegments: ["skills", "entries", "__proto__", "apiKey"],
      ref: OPENAI_API_KEY_ENV_REF,
    };
    await expect(apply(createPlan({ targets: [target] }), false)).rejects.toThrow(
      "Invalid plan target path",
    );
  });

  it("applies provider upserts and deletes from plan", async () => {
    const { apiKey: _key, ...openai } = createOpenAiProviderConfig();
    await writeConfig({
      secrets: {
        providers: {
          envmain: { source: "env" },
          fileold: { source: "file", path: "/tmp/old-secrets.json", mode: "json" },
        },
      },
      models: { providers: { openai } },
    });

    const plan = createPlan({
      providerUpserts: {
        filemain: { source: "file", path: "/tmp/new-secrets.json", mode: "json" },
      },
      providerDeletes: ["fileold"],
      targets: [],
    });

    const nextConfig = await project(plan);
    expect(nextConfig.secrets?.providers?.fileold).toBeUndefined();
    expect(nextConfig.secrets?.providers?.filemain).toEqual({
      source: "file",
      path: "/tmp/new-secrets.json",
      mode: "json",
    });
  });

  it("enables plugin owners for plugin-managed exec provider upserts", async () => {
    await writeConfig({
      plugins: { entries: { vault: { hooks: { allowConversationAccess: false } } } },
    });

    const nextConfig = await project(createPluginProviderPlan());
    expect(nextConfig.plugins?.entries?.vault).toEqual({
      hooks: { allowConversationAccess: false },
      enabled: true,
    });
  });

  it.each([
    ["globally disabled", { enabled: false }, "plugins.enabled is false."],
    ["normalized owner denied", { deny: ["Vault"] }, 'plugins.deny includes "vault".'],
    [
      "normalized owner disabled",
      { entries: { Vault: { enabled: false } } },
      "plugins.entries.vault.enabled is false.",
    ],
    [
      "absent from allowlist",
      { allow: ["openai"] },
      'plugins.allow does not include "vault". Add the plugin to plugins.allow before applying this plan.',
    ],
  ] as const)(
    "rejects plugin-managed exec provider upserts when %s",
    async (_policy, plugins, reason) => {
      await writeConfig({ plugins });
      await expect(project(createPluginProviderPlan())).rejects.toThrow(
        `Cannot apply plugin-managed SecretRef provider "vault" because ${reason}`,
      );
    },
  );

  it("scrubs canonical state without touching an existing legacy directory", async () => {
    const homeDir = tempDirs.make("openclaw-secrets-apply-root-");
    const canonical = await createApplyFixture(homeDir);
    const clawdbotDir = path.join(homeDir, ".clawdbot");
    const clawdbotEnvPath = path.join(clawdbotDir, ".env");
    await fs.mkdir(clawdbotDir, { recursive: true });
    const env = {
      HOME: homeDir,
      OPENAI_API_KEY: "sk-openai-plaintext", // pragma: allowlist secret
    };

    await writeJsonFile(canonical.configPath, {
      models: { providers: { openai: createOpenAiProviderConfig() } },
    });
    await writeJsonFile(canonical.authStorePath, createAuthProfileStoreFixture({}));
    await fs.writeFile(
      canonical.envPath,
      "OPENAI_API_KEY=sk-openai-plaintext\nUNRELATED=value\n", // pragma: allowlist secret
      "utf8",
    );
    await fs.writeFile(
      clawdbotEnvPath,
      "OPENAI_API_KEY=sk-should-not-touch\nUNRELATED=legacy\n", // pragma: allowlist secret
      "utf8",
    );

    const plan = scrubPlan();
    expect(await runSecretsApply({ plan, env, write: true })).toMatchObject({
      mode: "write",
      changed: true,
    });

    expect(await readText(canonical.envPath)).toBe("UNRELATED=value\n");
    expect(await readText(clawdbotEnvPath)).toBe(
      "OPENAI_API_KEY=sk-should-not-touch\nUNRELATED=legacy\n",
    );
  });

  it("preserves normalized restrictive plugin allowlist entries for plugin-managed exec provider upserts", async () => {
    await writeConfig({ plugins: { allow: ["Vault"] } });

    const nextConfig = await project(createPluginProviderPlan());
    expect(nextConfig.plugins?.allow).toEqual(["Vault"]);
    expect(nextConfig.plugins?.entries?.vault).toEqual({ enabled: true });
  });

  it("scrubs config and state .env files when the config path is external", async () => {
    const configDir = path.join(fixture.rootDir, "config");
    const configPath = path.join(configDir, "openclaw.json");
    const configEnvPath = path.join(configDir, ".env");
    await fs.mkdir(configDir, { recursive: true });
    await fs.copyFile(fixture.configPath, configPath);
    await fs.copyFile(fixture.envPath, configEnvPath);
    fixture.env.OPENCLAW_CONFIG_PATH = configPath;

    const applied = await apply(scrubPlan());

    expect(applied.changedFiles).toEqual(expect.arrayContaining([configEnvPath, fixture.envPath]));
    await expect(fs.readFile(configEnvPath, "utf8")).resolves.toBe("UNRELATED=value\n");
    await expect(fs.readFile(fixture.envPath, "utf8")).resolves.toBe("UNRELATED=value\n");
  });
});
