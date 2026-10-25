import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { MissingPublicSurfaceError } from "../plugin-sdk/facade-loader.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderPolicySurface } from "../plugins/provider-policy-surface.js";
import {
  registerBundledHealthChecks,
  resolveBundledHealthCheckPluginStateMode,
  resolveCodexHealthApi,
} from "./bundled-health-checks.js";
import { runDoctorLintChecks, selectUpdateReadinessChecks } from "./doctor-lint-flow.js";
import {
  clearHealthChecksForTest,
  getHealthCheck,
  listHealthChecks,
} from "./health-check-registry.js";

const STATE_DEFERRED_CHECK_ID = "memory-core/managed-local-embedding-setup";

const mocks = vi.hoisted(() => ({
  registerCodexManagedAppServerDoctorChecks: vi.fn(() => {
    throw new Error("Unable to resolve bundled plugin public surface codex/api.js");
  }),
  inspectEmbeddingProviderSetup: vi.fn(),
  loadBundledPluginManifestRegistry: vi.fn((): PluginManifestRegistry => ({
    plugins: [],
    diagnostics: [],
  })),
  loadPluginManifestRegistryForPluginRegistry: vi.fn((): PluginManifestRegistry => ({
    plugins: [],
    diagnostics: [],
  })),
  registerCuaDriverDoctorChecks: vi.fn(),
  registerMemoryCoreDoctorChecks: vi.fn(),
  registerPolicyDoctorChecks: vi.fn(),
  registerWorkerProviderDoctorChecks: vi.fn(),
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: vi.fn(
    ({ dirName }: { dirName: string }) =>
      dirName === "crabbox"
        ? { registerWorkerProviderDoctorChecks: mocks.registerWorkerProviderDoctorChecks }
        : null,
  ),
  loadBundledPluginPublicArtifactModuleSync: vi.fn(({ dirName }: { dirName: string }) =>
    dirName === "memory-core"
      ? {
          pluginStateIsolatedDoctorCheckIds: [STATE_DEFERRED_CHECK_ID],
          registerMemoryCoreDoctorChecks: mocks.registerMemoryCoreDoctorChecks,
        }
      : dirName === "cua-computer"
        ? { registerCuaDriverDoctorChecks: mocks.registerCuaDriverDoctorChecks }
        : dirName === "codex"
          ? mocks.registerCodexManagedAppServerDoctorChecks()
          : { registerPolicyDoctorChecks: mocks.registerPolicyDoctorChecks },
  ),
  resolveProviderPolicySurface: vi.fn((): ProviderPolicySurface | null => ({
    inspectEmbeddingProviderSetup: mocks.inspectEmbeddingProviderSetup,
  })),
}));

// This suite replaces the provider registry. Supply its official OpenAI route
// preference so implicit and explicit health ownership remain distinct.
vi.mock("../agents/openai-routing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/openai-routing.js")>()),
  resolveOpenAIImplicitAgentRuntime: ({ provider }: { provider?: string }) =>
    provider === "openai" ? "codex" : null,
}));
vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: mocks.loadPluginManifestRegistryForPluginRegistry,
}));
vi.mock("../plugins/manifest-registry-build.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/manifest-registry-build.js")>()),
  loadBundledPluginManifestRegistry: mocks.loadBundledPluginManifestRegistry,
}));
vi.mock("../plugins/provider-public-artifacts.js", () => ({
  resolveProviderPolicySurface: mocks.resolveProviderPolicySurface,
}));
vi.mock("../plugins/public-surface-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/public-surface-loader.js")>()),
  loadBundledPluginPublicArtifactModuleFromCandidatesSync:
    mocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync,
  loadBundledPluginPublicArtifactModuleSync: mocks.loadBundledPluginPublicArtifactModuleSync,
}));

function manifests(...plugins: PluginManifestRegistry["plugins"]) {
  return { plugins, diagnostics: [] };
}

let workspaceDir: string;
function register(
  cfg: OpenClawConfig = {},
  options: Omit<Parameters<typeof registerBundledHealthChecks>[0], "cfg" | "cwd"> = {},
) {
  return registerBundledHealthChecks({ cfg, cwd: workspaceDir, ...options });
}

function inspectMemory(env: NodeJS.ProcessEnv = process.env) {
  const host = mocks.registerMemoryCoreDoctorChecks.mock.calls[0]?.[0];
  return host?.inspectEmbeddingProviderSetup({
    config: {},
    env,
    agentId: "main",
    provider: "local",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue(manifests());
  workspaceDir = join(tmpdir(), `bundled-health-${process.pid}-${Date.now()}`);
  mkdirSync(workspaceDir, { recursive: true });
  workspaceDir = realpathSync(workspaceDir);
});

afterEach(() => {
  clearHealthChecksForTest();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it.each<[Parameters<typeof resolveBundledHealthCheckPluginStateMode>[0], string]>([
  [{ onlyIds: [STATE_DEFERRED_CHECK_ID] }, "deferred"],
  [{ includeAllChecks: true }, "isolated"],
  [{ updateReadiness: "post-plugin" }, "isolated"],
  [{ onlyIds: [STATE_DEFERRED_CHECK_ID, "core/doctor/final-config-validation"] }, "isolated"],
  [{}, "direct"],
  [{ onlyIds: ["core/doctor/final-config-validation"] }, "direct"],
])("resolves plugin state for %j as %s", (selection, expected) => {
  expect(resolveBundledHealthCheckPluginStateMode(selection)).toBe(expected);
  if (selection.onlyIds === undefined && selection.includeAllChecks !== true) {
    expect(mocks.loadBundledPluginPublicArtifactModuleSync).not.toHaveBeenCalled();
  }
});

it("keeps the check inactive when memory-core does not own memory", () => {
  register({ plugins: { slots: { memory: "none" } } });

  expect(mocks.registerMemoryCoreDoctorChecks.mock.lastCall?.[0]).toMatchObject({
    memoryCoreActive: false,
  });
});

it("returns no inspector when the selected provider exposes no policy surface", async () => {
  mocks.resolveProviderPolicySurface.mockReturnValueOnce(null);
  register();

  await expect(inspectMemory()).resolves.toBeUndefined();
});

it("scopes plugin state only while the selected provider setup is inspected", async () => {
  const sourceEnv = { ...process.env, OPENCLAW_STATE_DIR: "/operator/state" };
  const pluginMetadataEnv = {
    ...sourceEnv,
    OPENCLAW_STATE_DIR: "/private/read-only-state",
  };
  let snapshotRuns = 0;
  const runWithPluginStateSnapshot = async <T>(
    run: (env: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> => {
    snapshotRuns += 1;
    return await run(pluginMetadataEnv);
  };
  mocks.inspectEmbeddingProviderSetup.mockResolvedValueOnce(null);

  register({}, { env: sourceEnv, runWithPluginStateSnapshot });

  expect(snapshotRuns).toBe(0);
  await expect(inspectMemory(sourceEnv)).resolves.toBeNull();
  expect(snapshotRuns).toBe(1);
  expect(mocks.loadPluginManifestRegistryForPluginRegistry).toHaveBeenCalledWith({
    config: {},
    workspaceDir,
    env: pluginMetadataEnv,
  });
  expect(mocks.inspectEmbeddingProviderSetup).toHaveBeenCalledWith(
    expect.objectContaining({ env: pluginMetadataEnv }),
  );
});

it("loads CUA Driver artifact health when the plugin is enabled", () => {
  register({ plugins: { entries: { "cua-computer": { enabled: true } } } });

  expect(mocks.registerCuaDriverDoctorChecks).toHaveBeenCalledExactlyOnceWith({
    registerHealthCheck: expect.any(Function),
  });
});

it("loads configured worker-provider health through its bundled manifest owner", () => {
  mocks.loadBundledPluginManifestRegistry.mockReturnValueOnce(
    manifests(
      createPluginManifestRecordFixture({
        id: "crabbox",
        rootDir: "/bundled/crabbox",
        contracts: { workerProviders: ["crabbox"] },
      }),
    ),
  );

  register({ cloudWorkers: { profiles: { aws: { provider: "crabbox" } } } });

  expect(mocks.loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledWith({
    dirName: "crabbox",
    artifactCandidates: ["doctor-health-api.js"],
  });
  expect(mocks.registerWorkerProviderDoctorChecks).toHaveBeenCalledExactlyOnceWith({
    getHealthCheck: expect.any(Function),
    registerHealthCheck: expect.any(Function),
    inspectSetupSecrets: expect.any(Function),
    listPluginStateEntries: expect.any(Function),
  });
});

const codexConfig: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.6-sol" },
      models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
    },
  },
};

const implicitCodexConfig: OpenClawConfig = {
  agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
  plugins: { entries: { codex: { enabled: true }, policy: { enabled: true } } },
};

it("registers update readiness without loading unselected runtime health APIs", () => {
  register(
    {
      ...codexConfig,
      plugins: {
        entries: { policy: { enabled: true }, "cua-computer": { enabled: true } },
      },
      cloudWorkers: { profiles: { aws: { provider: "crabbox" } } },
    },
    { updateReadiness: "post-plugin" },
  );

  expect(mocks.registerMemoryCoreDoctorChecks).toHaveBeenCalledOnce();
  expect(mocks.loadPluginManifestRegistryForPluginRegistry).not.toHaveBeenCalled();
  expect(mocks.registerPolicyDoctorChecks).not.toHaveBeenCalled();
  expect(mocks.registerCuaDriverDoctorChecks).not.toHaveBeenCalled();
  expect(mocks.loadBundledPluginManifestRegistry).not.toHaveBeenCalled();
});

it("retains owner identities and blocking findings across readiness registration", async () => {
  const finding = {
    checkId: STATE_DEFERRED_CHECK_ID,
    severity: "error" as const,
    message: "not ready",
  };
  const check = {
    id: STATE_DEFERRED_CHECK_ID,
    kind: "plugin" as const,
    description: "Readiness owner",
    defaultEnabled: false,
    detect: vi.fn(async () => [finding]),
  };
  for (const updateReadiness of [undefined, "post-plugin", "post-plugin"] as const) {
    mocks.registerMemoryCoreDoctorChecks.mockImplementationOnce((host) => {
      if (host.getHealthCheck(check.id) !== check) {
        host.registerHealthCheck(check);
      }
    });
    register({}, { updateReadiness });
    expect(getHealthCheck(check.id)).toBe(check);
  }
  const callbacks = mocks.registerMemoryCoreDoctorChecks.mock.calls.map(
    ([host]) => host.registerHealthCheck,
  );
  expect(new Set(callbacks).size).toBe(1);
  const ctx = {
    cfg: {},
    mode: "lint" as const,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  };
  await expect(runDoctorLintChecks(ctx)).resolves.toMatchObject({ checksRun: 0, findings: [] });
  await expect(
    runDoctorLintChecks(ctx, {
      checks: selectUpdateReadinessChecks(listHealthChecks(), "post-plugin"),
      includeAllChecks: true,
    }),
  ).resolves.toMatchObject({ checksRun: 1, findings: [finding] });
});

it("fails when the selected readiness owner cannot load its artifact", () => {
  mocks.loadBundledPluginPublicArtifactModuleSync.mockImplementationOnce(() => {
    throw new MissingPublicSurfaceError("selected readiness artifact unavailable");
  });
  expect(() => register(codexConfig, { updateReadiness: "post-plugin" })).toThrow(
    "selected readiness artifact unavailable",
  );
});

function codexRecord(
  origin: "bundled" | "global",
  trustedOfficialInstall?: boolean,
  healthChecks = true,
) {
  const manifestPath = join(workspaceDir, "openclaw.plugin.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      id: "codex",
      configSchema: {},
      ...(healthChecks ? { doctorHealthChecks: true } : {}),
    }),
  );
  const loaded = loadPluginManifest(workspaceDir);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  return createPluginManifestRecordFixture({
    id: "codex",
    origin,
    trustedOfficialInstall,
    rootDir: workspaceDir,
    manifestPath,
    doctorHealthChecks: loaded.manifest.doctorHealthChecks,
    contracts: {},
  });
}

it("runs the selected bundled Codex health artifact with implicit routing", async () => {
  const cfg = implicitCodexConfig;
  mkdirSync(join(workspaceDir, "dist"));
  writeFileSync(
    join(workspaceDir, "dist", "api.js"),
    `
        module.exports.registerCodexManagedAppServerDoctorChecks = (host) => {
          if (!host.getHealthCheck("codex/managed-app-server")) {
            host.registerHealthCheck({
              id: "codex/managed-app-server", kind: "plugin", source: "codex",
              description: "Selected artifact check", detect: async () => [],
            });
          }
        };
      `,
  );
  mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue(
    manifests(codexRecord("bundled", false)),
  );
  const env = { ...process.env, OPENCLAW_STATE_DIR: join(workspaceDir, "state") };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    register(cfg, { env });
  }
  const check = getHealthCheck("codex/managed-app-server");
  expect(check?.description).toBe("Selected artifact check");
  await expect(
    check?.detect({
      cfg,
      env,
      mode: "lint",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    }),
  ).resolves.toEqual([]);
  expect(mocks.registerCodexManagedAppServerDoctorChecks).not.toHaveBeenCalled();
});

it.each([
  ["implicit missing owner", undefined],
  ["retained stable owner", undefined],
  ["missing", "not found"],
  ["untrusted", "not a bundled or verified official installation"],
  ["missing-api", "health API could not be loaded"],
  ["missing-export", "health checks are incomplete"],
] as const)(
  "continues other checks and reports selected Codex availability: %s",
  (state, warning) => {
    const implicit = state === "implicit missing owner";
    mocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue(
      implicit || state === "missing"
        ? manifests()
        : manifests(
            codexRecord("global", state !== "untrusted", state !== "retained stable owner"),
          ),
    );
    if (state === "untrusted") {
      writeFileSync(
        join(workspaceDir, "api.js"),
        'throw new Error("untrusted artifact executed");',
      );
    }
    if (state === "missing-export") {
      writeFileSync(join(workspaceDir, "api.js"), "module.exports = {};");
    }
    if (implicit) {
      expect(resolveCodexHealthApi({ cfg: implicitCodexConfig, cwd: workspaceDir })).toEqual({
        status: "not-configured",
      });
    }
    const findings = register(
      implicit
        ? implicitCodexConfig
        : {
            ...codexConfig,
            plugins: { entries: { policy: { enabled: true } } },
          },
    );
    if (warning) {
      expect(findings).toMatchObject([
        {
          checkId: "core/doctor/codex-session-routes",
          source: "codex",
          severity: "warning",
        },
      ]);
      expect(findings[0]?.message).toContain("openclaw doctor --fix");
      expect(findings[0]?.message).toContain(warning);
      expect(findings[0]?.message).toContain(
        state === "missing" || state === "untrusted"
          ? "openclaw plugins install @openclaw/codex"
          : "openclaw plugins inspect codex --runtime --json",
      );
    } else {
      expect(findings).toEqual([]);
    }
    expect(mocks.registerMemoryCoreDoctorChecks).toHaveBeenCalledOnce();
    expect(mocks.registerPolicyDoctorChecks).toHaveBeenCalledOnce();
    expect(getHealthCheck("codex/managed-app-server")).toBeUndefined();
    expect(mocks.registerCodexManagedAppServerDoctorChecks).not.toHaveBeenCalled();
  },
);

it("preserves disabled Codex policy without loading plugin code", () => {
  register({ ...codexConfig, plugins: { entries: { codex: { enabled: false } } } });
  expect(mocks.loadPluginManifestRegistryForPluginRegistry).not.toHaveBeenCalled();
  expect(mocks.registerCodexManagedAppServerDoctorChecks).not.toHaveBeenCalled();
});

it("honors plugin control-plane disablement for policy checks", () => {
  for (const plugins of [
    { enabled: false, entries: { policy: { enabled: true } } },
    { deny: ["policy"], entries: { policy: { enabled: true } } },
    { allow: ["telegram"], entries: { policy: { enabled: true } } },
  ]) {
    vi.clearAllMocks();

    register({ plugins });

    expect(mocks.registerPolicyDoctorChecks).not.toHaveBeenCalled();
  }
});
