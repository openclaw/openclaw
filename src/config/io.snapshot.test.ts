import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as doctorLegacy from "../commands/doctor/shared/legacy-config-issues.js";
import * as channelPresence from "../plugins/channel-presence-policy.js";
import * as pluginIndexState from "../plugins/installed-plugin-index-record-state.js";
import * as manifestRegistry from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createConfigIoContext } from "./io.context.js";
import { createConfigIO } from "./io.factory.js";
import { createConfigReadError } from "./io.invalid-config.js";
import { createRecoveryConfigEnv } from "./io.observe-recovery.test-support.js";
import { readBestEffortConfigSnapshot } from "./io.runtime.js";
import {
  readConfigFileSnapshotFromContext as readSnapshot,
  readConfigFileSnapshotWithPluginMetadataFromContext as readWithMetadata,
} from "./io.snapshot.js";
import {
  cloneConfigWithResolutionFacts as cloneWithFacts,
  getAuthoredConfigSecretRef as secretRef,
  getConfigResolutionFacts as resolutionFacts,
} from "./resolution-facts.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
});

function fixture(
  config?: unknown,
  options: { root?: string; configPath?: string; pluginValidation?: "core-only" | "full" } = {},
) {
  const root = options.root ?? tempDirs.make("openclaw-config-snapshot-");
  const configPath = options.configPath ?? path.join(root, "openclaw.json");
  if (config !== undefined) {
    fs.writeFileSync(configPath, JSON.stringify(config));
  }
  return createConfigIoContext({
    pluginValidation: options.pluginValidation,
    configPath,
    env: createRecoveryConfigEnv(root, configPath, path.join(root, "state")),
    homedir: () => root,
    observe: false,
  });
}

it.skipIf(process.platform === "win32")(
  "reads captured root bytes with relative includes without following the live config alias",
  async () => {
    const root = tempDirs.make("openclaw-captured-config-");
    const context = fixture(undefined, { root });
    fs.symlinkSync(path.join(root, "missing-live-config.json"), context.configPath);
    fs.writeFileSync(path.join(root, "settings.json5"), '{ gateway: { mode: "local" } }');

    const snapshot = await createConfigIO({
      ...context.deps,
      pluginValidation: "core-only",
    }).readConfigFileSnapshotFromRaw('{ $include: "./settings.json5" }');

    expect(snapshot).toMatchObject({
      valid: true,
      config: { gateway: { mode: "local" } },
      raw: '{ $include: "./settings.json5" }',
    });
    expect(fs.existsSync(path.join(root, "missing-live-config.json"))).toBe(false);
  },
);

it.each(["file", "includes", "validate"])("keeps %s errors private", async (phase) => {
  const raw = '{"gateway":{"mode":"local"}}';
  const context = fixture({ gateway: { mode: "local" } });
  const cause = Object.assign(new Error("config read fixture failed"), {
    diagnosticContext: "private-cause-context",
  });
  context.deps.measure = async (name, run) => {
    if (name === `config.snapshot.read.${phase}`) {
      throw cause;
    }
    return await run();
  };

  const snapshot = await readSnapshot(context);

  expect(snapshot.valid).toBe(false);
  expect(snapshot.issues[0]).toHaveProperty("cause", cause);
  expect(snapshot.issues[0]?.message).toContain(context.configPath);
  const failure = createConfigReadError(snapshot);
  expect(failure.cause).toBe(cause);
  expect(failure.message).toContain(context.configPath);
  expect(snapshot.readError).toEqual(phase === "file" ? { code: null } : undefined);
  expect(JSON.stringify(snapshot)).not.toMatch(/private-cause-context|"cause"/u);
  expect(fs.readFileSync(context.configPath, "utf8")).toBe(raw);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "retains an inaccessible config parent as a read failure rather than a missing config",
  async () => {
    const root = tempDirs.make("openclaw-config-inaccessible-parent-");
    const parent = path.join(root, "restricted");
    fs.mkdirSync(parent);
    const configPath = path.join(parent, "openclaw.json");
    const source = '{"gateway":{"mode":"local"}}';
    fs.writeFileSync(configPath, source);
    const context = fixture(undefined, { root, configPath, pluginValidation: "core-only" });
    fs.chmodSync(parent, 0);
    try {
      expect(fs.existsSync(configPath)).toBe(false);
      const snapshot = await readSnapshot(context);
      expect(snapshot).toMatchObject({
        valid: false,
        raw: null,
        readError: { code: "EACCES" },
        issues: [{ errorCode: "CONFIG_READ_FAILED" }],
      });
    } finally {
      fs.chmodSync(parent, 0o700);
    }
    expect(fs.readFileSync(configPath, "utf8")).toBe(source);
  },
);

it("preserves source paths across core-only and prepared plugin reads with a Windows home", async () => {
  const context = fixture();
  const windowsHome = "C:\\Users\\fixture";
  const resolve = path.resolve;
  const resolveWindows = path.win32.resolve;
  vi.spyOn(path, "resolve").mockImplementation((...segments) =>
    segments.some((segment) => segment.startsWith(windowsHome))
      ? resolveWindows(...segments)
      : resolve(...segments),
  );
  context.pathResolution = { env: {}, homedir: () => windowsHome };
  const plugins = {
    enabled: false,
    entries: { wiki: { config: { store: { path: "~/.openclaw/wiki" } } } },
  };
  fs.writeFileSync(context.configPath, JSON.stringify({ plugins }));
  context.options.pluginValidation = "core-only";
  const core = await readSnapshot(context);
  context.options.pluginValidation = "full";
  const { snapshot: full } = await readWithMetadata(context, {
    prepareValidation: "runtime",
  });

  expect(core.sourceConfig).toEqual(full.sourceConfig);
  for (const snapshot of [core, full]) {
    expect(snapshot.valid).toBe(true);
    expect(snapshot.authoredConfig?.plugins).toEqual(plugins);
    expect(snapshot.sourceConfig.plugins).toEqual(plugins);
    expect(snapshot.sourceConfigBeforeMigrations?.plugins).toEqual(plugins);
    expect(snapshot.runtimeConfig.plugins?.entries?.wiki?.config).toEqual({
      store: { path: "C:\\Users\\fixture\\.openclaw\\wiki" },
    });
  }
});

const legacyAgents = { list: [{ id: "primary", default: true }, { id: "secondary" }] };
it.each([
  {
    mode: "full",
    config: { agents: legacyAgents, channels: { discord: { enabled: false } } },
    issue: { path: "agents.list", message: expect.stringContaining("doctor --fix") },
    legacy: undefined,
    spy: () => vi.spyOn(channelPresence, "listChannelIdsForOwnershipMigration"),
  },
  {
    mode: "core-only",
    config: {
      nodeHost: { browserProxy: { enabled: "invalid" } },
      channels: { discord: {} },
      session: { typingMode: "thinking" },
    },
    issue: { path: "nodeHost.browserProxy.enabled" },
    legacy: "session.typingMode",
    spy: () => vi.spyOn(doctorLegacy, "findDoctorLegacyConfigIssues"),
  },
  {
    mode: "full",
    config: { skills: { workshop: { approvalPolicy: "pending" } } },
    issue: { path: "skills.workshop", message: expect.stringContaining("approvalPolicy") },
    legacy: "skills.workshop.approvalPolicy",
    spy: () => vi.spyOn(doctorLegacy, "findDoctorLegacyConfigIssues"),
  },
] as const)(
  "keeps Doctor repairs out of $mode validation",
  async ({ config, mode, issue, legacy, spy }) => {
    const context = fixture(config, { pluginValidation: mode });
    const repair = spy();
    const prepare = vi.spyOn(pluginIndexState, "preparePluginMetadataMachineStateAsync");
    const snapshot = await readSnapshot(context);
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues).toContainEqual(expect.objectContaining(issue));
    if (legacy) {
      expect(snapshot.legacyIssues).toContainEqual(expect.objectContaining({ path: legacy }));
    } else {
      expect(snapshot.sourceConfig.agents).toEqual(legacyAgents);
    }
    expect(repair).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  },
);

it("keeps best-effort core-only materialization independent of plugin metadata", async () => {
  const provider = { baseUrl: "https://example.test/v1", api: "openai-completions", models: [] };
  const context = fixture(
    { models: { providers: { "fixture-external": provider } } },
    { pluginValidation: "core-only" },
  );
  const discovery = vi.spyOn(manifestRegistry, "loadPluginManifestRegistryCore");
  const readOptions = { observe: false, pluginValidation: context.options.pluginValidation };
  const result = await withEnvAsync(context.deps.env, () =>
    readBestEffortConfigSnapshot(readOptions),
  );
  expect(result).toMatchObject({
    configDiagnostics: null,
    config: {
      models: { providers: { "fixture-external": { baseUrl: provider.baseUrl } } },
      agents: { defaults: { compaction: { mode: "safeguard" } } },
    },
  });
  expect(discovery.mock.calls.length).toBe(0);
});
it("records only genuinely missing substitutions as private facts", async () => {
  const context = fixture({
    gateway: {
      auth: {
        mode: "password",
        password: "${MISSING_GATEWAY_PASSWORD}",
        token: "$${ESCAPED_GATEWAY_TOKEN}",
      },
      remote: { token: "${GATEWAY_TOKEN}", password: "literal-${" },
    },
    hooks: { token: "$MISSING_HOOK_TOKEN" },
  });
  context.deps.env.GATEWAY_TOKEN = "${ENV_LITERAL_GATEWAY_TOKEN}";

  const snapshot = await readSnapshot(context);

  expect([...(resolutionFacts(snapshot.sourceConfigBeforeMigrations) ?? [])]).toEqual([
    "gateway.auth.password",
  ]);
  expect(snapshot.config.gateway).toMatchObject({
    auth: { token: "${ESCAPED_GATEWAY_TOKEN}" },
    remote: { token: "${ENV_LITERAL_GATEWAY_TOKEN}", password: "literal-${" },
  });
  expect(secretRef(snapshot.config, "hooks.token")).toEqual({
    source: "env",
    provider: "default",
    id: "MISSING_HOOK_TOKEN",
  });
  expect(secretRef(snapshot.config, "gateway.auth.password")?.id).toBe("MISSING_GATEWAY_PASSWORD");
  expect(secretRef(snapshot.config, "gateway.auth.token")).toBeNull();
  expect(secretRef(snapshot.config, "gateway.remote.token")).toBeNull();
  expect(secretRef(cloneWithFacts(snapshot.config), "hooks.token")?.id).toBe("MISSING_HOOK_TOKEN");
  expect(JSON.stringify(snapshot)).not.toContain("resolutionFacts");
});

it.each([false, true])("loads metadata only for valid snapshots (invalid=%s)", async (invalid) => {
  const context = fixture();
  if (invalid) {
    fs.writeFileSync(context.configPath, "{ invalid", "utf8");
  }
  const loader = vi.spyOn(context, "createValidationPluginMetadataSnapshotLoader");
  if (!invalid) {
    expect(await readSnapshot(context)).toMatchObject({ exists: false, valid: true });
    expect(loader.mock.results.every(({ value }) => value.getSnapshot() === undefined)).toBe(true);
  }
  const result = await readWithMetadata(context);
  if (invalid) {
    expect(result.snapshot.valid).toBe(false);
    expect(result.snapshot.authoredConfig).toBeUndefined();
    expect(result.pluginMetadataSnapshot).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
  } else {
    expect(result.snapshot).toMatchObject({ exists: false, valid: true });
    const metadata = result.pluginMetadataSnapshot;
    expect(structuredClone(metadata?.manifestRegistry)).toEqual(metadata?.manifestRegistry);
    expect(metadata).toMatchObject({
      configFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      index: { version: 1, hostContractVersion: expect.any(String), plugins: expect.any(Array) },
    });
  }
});
