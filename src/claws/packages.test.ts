import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { installPluginFromClawHub } from "../plugins/clawhub.js";
import { PLUGIN_ARTIFACT_ADAPTER_IDENTITY } from "../plugins/install-artifact-inspection.js";
import type { ClawHubSkillUninstallPlan } from "../skills/lifecycle/workspace-types.js";
import {
  installClawPackages as installClawPackagesCore,
  preflightClawPackage,
} from "./packages.js";
import {
  emptyPluginCapabilityEvidence,
  packageInstallPlan as plan,
} from "./packages.test-support.js";
import type { PersistedClawPackageRef } from "./provenance.js";

const integrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const pluginPackage = {
  kind: "plugin",
  source: "clawhub",
  ref: "@owner/audit",
  version: "2.0.1",
  integrity,
} as const;

const completePackageRef = vi.fn(
  (ref: PersistedClawPackageRef, status: PersistedClawPackageRef["status"]) => ({
    ...ref,
    status,
  }),
);
const pluginIntegrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function pluginPackageRef(
  ref: string,
  overrides: Partial<PersistedClawPackageRef> = {},
): PersistedClawPackageRef {
  return {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: "incident-2",
    clawName: "incident-claw",
    kind: "plugin",
    source: "clawhub",
    ref,
    version: "1.0.0",
    integrity: pluginIntegrity,
    status: "complete",
    relationship: "referenced",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 1_000,
    updatedAtMs: 2_000,
    ...overrides,
  };
}
type PluginProbe = Extract<Awaited<ReturnType<typeof installPluginFromClawHub>>, { ok: true }>;
function pluginProbe(overrides: Partial<PluginProbe> = {}): PluginProbe {
  return {
    ok: true,
    pluginId: "audit",
    packageName: "@owner/audit",
    targetDir: "/tmp/plugin",
    extensions: [],
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "@owner/audit",
      clawhubFamily: "code-plugin",
      integrity,
    },
    ...overrides,
  };
}
function withStagedInspection(probe: typeof installPluginFromClawHub) {
  return async (request: Parameters<typeof installPluginFromClawHub>[0]) => {
    const result = await probe(request);
    if (result.ok) {
      await request.onPluginArtifactInspect?.({
        pluginId: result.pluginId,
        stagedArtifactDir: "/tmp/staged-audit",
        mode: "install",
      });
    }
    return result;
  };
}
const inspectPluginCapabilities = vi.fn((_rootDir: string, pluginId: string) => ({
  ...emptyPluginCapabilityEvidence,
  grantsByPluginId: { [pluginId]: emptyPluginCapabilityEvidence.grants },
}));
const pluginConsent = {
  onCapabilityConsent: vi.fn(async (review: { reviewToken: string }) => ({
    reviewToken: review.reviewToken,
  })),
  confirmInstall: vi.fn(async () => true),
};
async function installClawPackages(
  packagePlan: Parameters<typeof installClawPackagesCore>[0],
  options: Parameters<typeof installClawPackagesCore>[1] = {},
) {
  return await installClawPackagesCore(packagePlan, {
    ...options,
    pluginConsent,
    deps: { inspectPluginCapabilities, ...options.deps },
  });
}
const acquirePackageLease = vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() }));
const probePlugin = vi.fn(async (request: Parameters<typeof installPluginFromClawHub>[0]) => {
  const { spec } = request;
  const pluginId = spec.slice(spec.lastIndexOf("/") + 1).split("@")[0]!;
  const packageName = spec.replace(/^clawhub:/, "").replace(/@[^@]+$/, "");
  await request.onPluginArtifactInspect?.({
    pluginId,
    stagedArtifactDir: "/tmp/staged-audit",
    mode: "install",
  });
  return {
    ok: true as const,
    pluginId,
    packageName,
    targetDir: "/tmp/plugin",
    extensions: [],
    clawhub: {
      source: "clawhub" as const,
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: packageName,
      clawhubFamily: "code-plugin" as const,
      integrity,
    },
  };
});

describe("preflightClawPackage plugin setup requirements", () => {
  const setup = {
    providers: [
      {
        id: "evidence",
        authMethods: ["api-key"],
        envVars: ["EVIDENCE_API_KEY", "EVIDENCE_TOKEN"],
      },
    ],
  };
  const artifactInspection = { format: "openclaw" as const, mapped: ["plugin"], unavailable: [] };
  const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "install" });
  const probePluginSetup = vi.fn().mockResolvedValue({
    ok: true,
    pluginId: "evidence",
    setup,
    artifactInspection,
    clawhub: { integrity },
  });

  it("reports plugin setup when no declared environment credential is present", async () => {
    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: {},
        deps: {
          preflightPlugin,
          probePlugin: withStagedInspection(probePluginSetup),
          inspectPluginCapabilities,
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        requirements: [
          {
            kind: "plugin-setup",
            plugin: "evidence",
            provider: "evidence",
            envVars: ["EVIDENCE_API_KEY", "EVIDENCE_TOKEN"],
            authMethods: ["api-key"],
          },
        ],
      }),
    );
  });

  it("accepts any declared credential from any provider", async () => {
    probePluginSetup.mockResolvedValueOnce({
      ok: true,
      pluginId: "evidence",
      setup: {
        providers: [
          { id: "first", envVars: ["FIRST_API_KEY"] },
          { id: "second", envVars: ["SECOND_API_KEY", "SECOND_TOKEN"] },
        ],
      },
      artifactInspection,
      clawhub: { integrity },
    });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: { SECOND_TOKEN: "configured" },
        deps: {
          preflightPlugin,
          probePlugin: withStagedInspection(probePluginSetup),
          inspectPluginCapabilities,
        },
      }),
    ).resolves.not.toHaveProperty("requirements");
  });

  it("does not gate readiness on an auth-method-only provider", async () => {
    probePluginSetup.mockResolvedValueOnce({
      ok: true,
      pluginId: "evidence",
      setup: {
        providers: [{ id: "oauth-only", authMethods: ["oauth"] }],
      },
      artifactInspection,
      clawhub: { integrity },
    });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        env: {},
        deps: {
          preflightPlugin,
          probePlugin: withStagedInspection(probePluginSetup),
          inspectPluginCapabilities,
        },
      }),
    ).resolves.not.toHaveProperty("requirements");
  });

  it("accepts declared local auth evidence", async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), "claw-auth-evidence-"));
    const credentialsPath = join(credentialsDir, "credentials.json");
    await writeFile(credentialsPath, "{}", "utf8");
    probePluginSetup.mockResolvedValueOnce({
      ok: true,
      pluginId: "evidence",
      setup: {
        providers: [
          {
            ...setup.providers[0],
            authEvidence: [
              {
                type: "local-file-with-env",
                fileEnvVar: "EVIDENCE_CREDENTIALS",
                requiresAllEnv: ["EVIDENCE_PROJECT"],
                credentialMarker: "evidence-local-credentials",
              },
            ],
          },
        ],
      },
      artifactInspection,
      clawhub: { integrity },
    });

    try {
      await expect(
        preflightClawPackage(pluginPackage, "/tmp/workspace", {
          env: {
            EVIDENCE_CREDENTIALS: credentialsPath,
            EVIDENCE_PROJECT: "project",
          },
          deps: {
            preflightPlugin,
            probePlugin: withStagedInspection(probePluginSetup),
            inspectPluginCapabilities,
          },
        }),
      ).resolves.not.toHaveProperty("requirements");
    } finally {
      await rm(credentialsDir, { recursive: true, force: true });
    }
  });
});

describe("installClawPackages", () => {
  const extension = {
    id: "audit-tools",
    format: "claude" as const,
    detectedFormat: "claude" as const,
    mapped: ["skills"],
    unavailable: ["agents"],
    adapterIdentity: PLUGIN_ARTIFACT_ADAPTER_IDENTITY,
  };

  it("installs skill packages into the planned workspace with the resolved digest", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const pending = {
      kind: "skill",
      ref: "@owner/triage",
      status: "pending",
      integrity: skillIntegrity,
    };
    const installSkill = vi.fn(async (params: { beforePersistentApply?: () => void }) => {
      params.beforePersistentApply?.();
      return {
        ok: true as const,
        slug: "triage",
        version: "1.2.3",
        targetDir: "/tmp/incident-2/skills/triage",
      };
    });
    const persistPackageRef = vi.fn().mockReturnValue(pending);
    const onExternalMutation = vi.fn();

    await installClawPackages(
      plan([
        {
          kind: "skill",
          source: "clawhub",
          ref: "@owner/triage",
          version: "1.2.3",
          integrity: skillIntegrity,
        },
      ]),
      {
        deps: {
          installSkill,
          preflightSkill: vi
            .fn()
            .mockResolvedValue({ ok: true, action: "install", integrity: skillIntegrity }),
          persistPackageRef,
          completePackageRef,
          acquirePackageLease,
        },
        onExternalMutation,
      },
    );

    expect(installSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/incident-2",
        slug: "@owner/triage",
        version: "1.2.3",
        expectedIntegrity: skillIntegrity,
        clawManaged: true,
        beforePersistentApply: expect.any(Function),
      }),
    );
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ integrity: skillIntegrity }),
      expect.objectContaining({
        status: "pending",
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
    expect(onExternalMutation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "skill", ref: "@owner/triage" }),
    );
  });

  it("registers a skill upgrade receipt before checking retired authority", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const skill = {
      kind: "skill" as const,
      source: "clawhub" as const,
      ref: "@owner/triage",
      version: "1.2.3",
      integrity: skillIntegrity,
    };
    const transaction = { commit: vi.fn(), rollback: vi.fn() };
    const onSkillTransaction = vi.fn();
    let retired = false;

    await expect(
      installClawPackages(plan([skill]), {
        assertCurrent: () => {
          if (retired) {
            throw new Error("owner retired during install telemetry");
          }
        },
        skillUpgrade: {
          ref: skill.ref,
          plan: {} as ClawHubSkillUninstallPlan,
          assertCurrent: async () => undefined,
        },
        onSkillTransaction,
        deps: {
          installSkill: vi.fn(async () => {
            retired = true;
            return {
              ok: true as const,
              slug: "triage",
              version: skill.version,
              targetDir: "/tmp/incident-2/skills/triage",
              transaction,
            };
          }),
          preflightSkill: vi.fn().mockResolvedValue({
            ok: true,
            action: "install",
            integrity: skillIntegrity,
          }),
          persistPackageRef: vi.fn().mockReturnValue({ ...skill, status: "pending" }),
          completePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toThrow("owner retired during install telemetry");

    expect(onSkillTransaction).toHaveBeenCalledWith(expect.objectContaining(skill), transaction);
  });

  it("reports uncertain skill artifacts before checking retired authority", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const skill = {
      kind: "skill" as const,
      source: "clawhub" as const,
      ref: "@owner/triage",
      version: "1.2.3",
      integrity: skillIntegrity,
    };
    const onExternalMutation = vi.fn();
    let retired = false;

    await expect(
      installClawPackages(plan([skill]), {
        assertCurrent: () => {
          if (retired) {
            throw new Error("owner retired during install telemetry");
          }
        },
        onExternalMutation,
        deps: {
          installSkill: vi.fn(async () => {
            retired = true;
            return { ok: false as const, error: "rollback incomplete", recoveryIncomplete: true };
          }),
          preflightSkill: vi.fn().mockResolvedValue({
            ok: true,
            action: "install",
            integrity: skillIntegrity,
          }),
          persistPackageRef: vi.fn().mockReturnValue({ ...skill, status: "pending" }),
          completePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toThrow("owner retired during install telemetry");

    expect(onExternalMutation).toHaveBeenCalledWith(expect.objectContaining(skill));
  });

  it("rejects an unreviewed skill warning before recording a ref or installing bytes", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const planned = plan([
      {
        kind: "skill",
        source: "clawhub",
        ref: "@owner/triage",
        version: "1.2.3",
        integrity: skillIntegrity,
      },
    ]);
    planned.actions[0]!.details!.riskWarning = "Review this skill.";
    const persistPackageRef = vi.fn();
    const installSkill = vi.fn();

    await expect(
      installClawPackages(planned, {
        deps: {
          preflightSkill: vi.fn().mockResolvedValue({
            ok: true,
            action: "install",
            integrity: skillIntegrity,
            warning: "Review this skill.",
          }),
          persistPackageRef,
          installSkill,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "skill_consent_required" });
    expect(persistPackageRef).not.toHaveBeenCalled();
    expect(installSkill).not.toHaveBeenCalled();
  });

  it("accepts only the reviewed skill warning at the installer trust check", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const planned = plan([
      {
        kind: "skill",
        source: "clawhub",
        ref: "@owner/triage",
        version: "1.2.3",
        integrity: skillIntegrity,
      },
    ]);
    planned.actions[0]!.details!.riskWarning = "Review this skill.";
    const skillConsent = { assertApproved: vi.fn() };
    const pending = { kind: "skill", ref: "@owner/triage", status: "pending" };
    const installSkill = vi.fn(
      async (params: { confirmInstall?: (warning?: string) => boolean | Promise<boolean> }) => {
        expect(await params.confirmInstall?.("Review this skill.")).toBe(true);
        expect(await params.confirmInstall?.("Changed trust warning.")).toBe(false);
        return {
          ok: true as const,
          slug: "triage",
          version: "1.2.3",
          targetDir: "/tmp/incident-2/skills/triage",
        };
      },
    );

    await installClawPackages(planned, {
      skillConsent,
      deps: {
        preflightSkill: vi.fn().mockResolvedValue({
          ok: true,
          action: "install",
          integrity: skillIntegrity,
          warning: "Review this skill.",
        }),
        persistPackageRef: vi.fn().mockReturnValue(pending),
        completePackageRef,
        installSkill,
        acquirePackageLease,
      },
    });
    expect(skillConsent.assertApproved).toHaveBeenCalledWith({
      ref: "@owner/triage",
      version: "1.2.3",
      integrity: skillIntegrity,
      riskWarning: "Review this skill.",
    });
  });

  it("installs plugins through the shared surface with the selected ClawHub source", async () => {
    probePlugin.mockClear();
    const workerEnv = { OPENCLAW_STATE_DIR: "/tmp/openclaw-claws" };
    const installPlugin = vi.fn().mockResolvedValue(undefined);
    const persistPackageRef = vi.fn().mockReturnValue({
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity,
    });
    const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "install" });

    await installClawPackages(plan([pluginPackage]), {
      env: workerEnv,
      clawHubBaseUrl: "http://127.0.0.1:3323",
      deps: {
        installPlugin,
        probePlugin,
        preflightPlugin,
        persistPackageRef,
        completePackageRef,
        acquirePackageLease,
      },
    });

    expect(installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          source: "clawhub",
          packageName: "@owner/audit",
          version: "2.0.1",
          mode: "install",
          expectedIntegrity:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          expectedPluginId: "audit",
        },
        invalidateRuntimeCache: false,
        clawManaged: true,
        env: {
          OPENCLAW_STATE_DIR: "/tmp/openclaw-claws",
          OPENCLAW_CLAWHUB_URL: "http://127.0.0.1:3323",
        },
      }),
    );
    expect(workerEnv).toEqual({ OPENCLAW_STATE_DIR: "/tmp/openclaw-claws" });
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      expect.objectContaining({
        status: "pending",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
  });

  it("resumes an exact Claw-introduced plugin requirement without reinstalling", async () => {
    probePlugin.mockClear();
    const introduced = pluginPackageRef("@owner/audit", {
      version: pluginPackage.version,
      integrity,
    });
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn().mockReturnValue(introduced);

    const result = await installClawPackages(plan([pluginPackage]), {
      deps: {
        installPlugin,
        probePlugin,
        preflightPlugin: vi.fn().mockResolvedValue({
          ok: true,
          action: "reuse",
          installedId: "audit",
          installedIntegrity: integrity,
        }),
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([introduced]),
        acquirePackageLease,
      },
    });

    expect(result).toEqual([introduced]);
    expect(installPlugin).not.toHaveBeenCalled();
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        status: "complete",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
  });

  it("records a dependency ref without reinstalling an exact reused plugin", async () => {
    probePlugin.mockClear();
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const preflightPlugin = vi.fn().mockResolvedValue({
      ok: true,
      action: "reuse",
      installedId: "audit",
      installedIntegrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const probePluginForExtension = vi.fn().mockResolvedValue(
      pluginProbe({
        artifactInspection: {
          format: "claude",
          mapped: ["skills"],
          unavailable: ["agents"],
        },
      }),
    );

    await installClawPackages(plan([{ ...pluginPackage, extension }], "reuse"), {
      deps: {
        installPlugin,
        probePlugin: withStagedInspection(probePluginForExtension),
        preflightPlugin,
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([]),
        acquirePackageLease,
      },
    });

    expect(installPlugin).not.toHaveBeenCalled();
    expect(probePluginForExtension).toHaveBeenCalledWith(
      expect.objectContaining({ extensionsDir: expect.any(String) }),
    );
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        extension,
      }),
      expect.objectContaining({
        status: "complete",
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
      }),
    );
  });

  it("rejects changed extension inspection before recording reused plugin provenance", async () => {
    const persistPackageRef = vi.fn();

    await expect(
      installClawPackages(plan([{ ...pluginPackage, extension }], "reuse"), {
        deps: {
          installPlugin: vi.fn(),
          probePlugin: withStagedInspection(
            vi.fn().mockResolvedValue(
              pluginProbe({
                artifactInspection: {
                  format: "claude",
                  mapped: ["skills", "commands"],
                  unavailable: ["agents"],
                },
              }),
            ),
          ),
          preflightPlugin: vi.fn().mockResolvedValue({
            ok: true,
            action: "reuse",
            installedId: "audit",
            installedIntegrity: integrity,
          }),
          persistPackageRef,
          completePackageRef,
          readPackageRefs: vi.fn().mockReturnValue([]),
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({
      code: "package_owner_state_changed",
      message: expect.stringContaining("identity or trust state changed after planning"),
    });
    expect(persistPackageRef).not.toHaveBeenCalled();
  });

  it("inherits Claw-introduced origin when another Claw already owns the plugin", async () => {
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const existing = {
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
    } as PersistedClawPackageRef;

    await installClawPackages(plan([pluginPackage], "reuse"), {
      deps: {
        installPlugin: vi.fn(),
        probePlugin,
        preflightPlugin: vi.fn().mockResolvedValue({
          ok: true,
          action: "reuse",
          installedId: "audit",
          installedIntegrity: integrity,
        }),
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([existing]),
        acquirePackageLease,
      },
    });

    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      }),
    );
  });

  it("preserves a newer independent plugin reinstall when another Claw reuses it", async () => {
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const existing = {
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
      updatedAtMs: 10,
    } as PersistedClawPackageRef;

    await installClawPackages(plan([pluginPackage], "reuse"), {
      deps: {
        installPlugin: vi.fn(),
        probePlugin,
        preflightPlugin: vi.fn().mockResolvedValue({
          ok: true,
          action: "reuse",
          installedId: "audit",
          installedIntegrity: integrity,
          installedAt: new Date(20).toISOString(),
        }),
        persistPackageRef,
        completePackageRef,
        readPackageRefs: vi.fn().mockReturnValue([existing]),
        acquirePackageLease,
      },
    });

    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        relationship: "referenced",
        origin: "pre-existing",
        independentOwner: true,
      }),
    );
  });

  it("marks the pending ref failed when a plugin install fails", async () => {
    const pending = {
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity,
    } as PersistedClawPackageRef;
    const persistPackageRef = vi.fn().mockReturnValue(pending);

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin: vi.fn().mockRejectedValue(new Error("registry unavailable")),
          probePlugin,
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          persistPackageRef,
          completePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({
      code: "package_install_failed",
      message: "registry unavailable",
      installedPackages: [expect.objectContaining({ ref: "@owner/audit", status: "failed" })],
    });
  });

  it("removes a newly installed plugin when a later package fails", async () => {
    const rollbackIntegrity =
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const installPlugin = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second install failed"));
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);
    const refs = [
      pluginPackageRef("@owner/first", { status: "pending" }),
      pluginPackageRef("@owner/second", { status: "pending" }),
    ];
    const persistPackageRef = vi.fn().mockReturnValueOnce(refs[0]).mockReturnValueOnce(refs[1]);
    const readPackageRefs = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([pluginPackageRef("@owner/first")]);

    await expect(
      installClawPackages(
        plan([
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/first",
            version: "1.0.0",
            integrity: rollbackIntegrity,
          },
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/second",
            version: "1.0.0",
            integrity: rollbackIntegrity,
          },
        ]),
        {
          deps: {
            installPlugin,
            uninstallPlugin,
            probePlugin,
            preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
            persistPackageRef,
            completePackageRef,
            readPackageRefs,
            acquirePackageLease,
            resolvePlugin: vi.fn().mockResolvedValue({
              status: "found",
              pluginId: "first",
              installedVersion: "1.0.0",
              record: {
                source: "clawhub",
                integrity: rollbackIntegrity,
                installedAt: new Date(1_500).toISOString(),
              },
            }),
          },
        },
      ),
    ).rejects.toMatchObject({ code: "package_install_failed", message: "second install failed" });

    expect(uninstallPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "first",
        caller: "cli",
        invalidateRuntimeCache: false,
        clawManaged: true,
      }),
    );
    expect(completePackageRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "@owner/first" }),
      "rolled_back",
      expect.anything(),
    );
  });

  it("keeps a newly installed plugin when a direct owner claims it before rollback", async () => {
    const installPlugin = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second install failed"));
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);
    const refs = [
      pluginPackageRef("@owner/first", { status: "pending" }),
      pluginPackageRef("@owner/second", { status: "pending" }),
    ];

    await expect(
      installClawPackages(
        plan([
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/first",
            version: "1.0.0",
            integrity: pluginIntegrity,
          },
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/second",
            version: "1.0.0",
            integrity: pluginIntegrity,
          },
        ]),
        {
          deps: {
            installPlugin,
            uninstallPlugin,
            probePlugin,
            preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
            persistPackageRef: vi.fn().mockReturnValueOnce(refs[0]).mockReturnValueOnce(refs[1]),
            completePackageRef,
            readPackageRefs: vi
              .fn()
              .mockReturnValueOnce([])
              .mockReturnValueOnce([pluginPackageRef("@owner/first", { independentOwner: true })]),
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "package_rollback_failed",
      message: expect.stringContaining("now has a direct owner"),
    });

    expect(uninstallPlugin).not.toHaveBeenCalled();
  });

  it("preserves the installer error when failure provenance cannot be updated", async () => {
    const pending = {
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity,
    } as PersistedClawPackageRef;
    const failingCompletePackageRef = vi.fn(() => {
      throw new Error("state database unavailable");
    });

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin: vi.fn().mockRejectedValue(new Error("registry unavailable")),
          probePlugin,
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          persistPackageRef: vi.fn().mockReturnValue(pending),
          completePackageRef: failingCompletePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({
      code: "package_install_failed",
      message: "registry unavailable",
      installedPackages: [pending],
    });
    expect(failingCompletePackageRef).toHaveBeenCalledWith(pending, "failed", expect.anything());
  });

  it("invalidates consent when plugin owner state changes after planning", async () => {
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn();
    const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "reuse" });

    await expect(
      installClawPackages(plan([pluginPackage]), {
        deps: {
          installPlugin,
          probePlugin,
          preflightPlugin,
          persistPackageRef,
          completePackageRef,
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
    expect(installPlugin).not.toHaveBeenCalled();
    expect(persistPackageRef).not.toHaveBeenCalled();
  });

  it("invalidates consent when a skill trust warning changes after planning", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const planned = plan([
      {
        kind: "skill",
        source: "clawhub",
        ref: "@owner/triage",
        version: "1.2.3",
        integrity: skillIntegrity,
      },
    ]);
    Object.assign(planned.actions[0]!.details!, { riskWarning: "review warning one" });

    await expect(
      installClawPackages(planned, {
        deps: {
          preflightSkill: vi.fn().mockResolvedValue({
            ok: true,
            action: "install",
            integrity: skillIntegrity,
            warning: "review warning two",
          }),
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
  });

  it("invalidates consent when a plugin trust warning changes after planning", async () => {
    const planned = plan([pluginPackage]);
    Object.assign(planned.actions[0]!.details!, { riskWarning: "review warning one" });

    await expect(
      installClawPackages(planned, {
        deps: {
          probePlugin: withStagedInspection(
            vi.fn().mockResolvedValue({
              ok: true,
              pluginId: "audit",
              warning: "review warning two",
              clawhub: { integrity },
            }),
          ),
          acquirePackageLease,
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
  });
});
