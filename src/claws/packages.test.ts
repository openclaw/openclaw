import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { PLUGIN_ARTIFACT_ADAPTER_IDENTITY } from "../plugins/install-artifact-inspection.js";
import {
  installClawPackages as installClawPackagesCore,
  testPluginPackage as pluginPackage,
  testPluginProbe as pluginProbe,
  testPackageLease,
  withStagedInspection,
} from "./packages.boundary.test-support.js";
import { preflightClawPackage } from "./packages.js";
import {
  emptyPluginCapabilityEvidence,
  packageInstallPlan as plan,
} from "./packages.test-support.js";

const { integrity } = pluginPackage;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
const skillPackage = {
  kind: "skill",
  source: "clawhub",
  ref: "@owner/triage",
  version: "1.2.3",
  integrity: skillIntegrity,
} as const;
const installedSkill = {
  ok: true as const,
  slug: "triage",
  version: "1.2.3",
  targetDir: "/tmp/incident-2/skills/triage",
};
function skillPlan(riskWarning?: string) {
  const planned = plan([skillPackage]);
  if (riskWarning) {
    planned.actions[0]!.details!.riskWarning = riskWarning;
  }
  return planned;
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
  deps: NonNullable<Parameters<typeof installClawPackagesCore>[1]>["deps"],
  options: Omit<NonNullable<Parameters<typeof installClawPackagesCore>[1]>, "deps"> = {},
) {
  return await installClawPackagesCore(packagePlan, {
    ...options,
    pluginConsent,
    deps: { inspectPluginCapabilities, acquirePackageLease, ...deps },
  });
}
const acquirePackageLease = vi.fn(async () => testPackageLease());
const probePlugin = vi.fn(
  withStagedInspection(async ({ spec }) => {
    const pluginId = spec.slice(spec.lastIndexOf("/") + 1).split("@")[0]!;
    const packageName = spec.replace(/^clawhub:/, "").replace(/@[^@]+$/, "");
    return pluginProbe({
      pluginId,
      packageName,
      clawhub: { ...pluginProbe().clawhub, clawhubPackage: packageName },
    });
  }),
);
const preflightSkill = (warning?: string) =>
  vi.fn().mockResolvedValue({ ok: true, action: "install", integrity: skillIntegrity, warning });
const preflightPlugin = (action = "install") => vi.fn().mockResolvedValue({ ok: true, action });
const reusePlugin = () =>
  vi.fn().mockResolvedValue({
    ok: true,
    action: "reuse",
    installedId: "audit",
    installedIntegrity: integrity,
  });
const extensionProbe = (mapped = ["skills"]) =>
  vi
    .fn()
    .mockResolvedValue(
      pluginProbe({ artifactInspection: { format: "claude", mapped, unavailable: ["agents"] } }),
    );
function expectReceipt(
  result: Awaited<ReturnType<typeof installClawPackages>>,
  expected: { integrity: string; relationship: string; origin: string; extension?: unknown },
) {
  expect(result).toMatchObject([
    { status: "complete", independentOwner: expected.origin === "pre-existing", ...expected },
  ]);
}

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
  const preflightPluginSetup = preflightPlugin();
  const setupProbe = (providerSetup: unknown) => ({
    ok: true,
    pluginId: "evidence",
    setup: providerSetup,
    artifactInspection,
    clawhub: { integrity },
  });
  const probePluginSetup = vi.fn().mockResolvedValue(setupProbe(setup));

  const preflight = (env: NodeJS.ProcessEnv = {}) =>
    preflightClawPackage(pluginPackage, "/tmp/workspace", {
      env,
      deps: {
        preflightPlugin: preflightPluginSetup,
        probePlugin: withStagedInspection(probePluginSetup),
        inspectPluginCapabilities,
      },
    });
  it("reports plugin setup when no declared environment credential is present", async () => {
    await expect(preflight()).resolves.toEqual(
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
    probePluginSetup.mockResolvedValueOnce(
      setupProbe({
        providers: [
          { id: "first", envVars: ["FIRST_API_KEY"] },
          { id: "second", envVars: ["SECOND_API_KEY", "SECOND_TOKEN"] },
        ],
      }),
    );

    await expect(preflight({ SECOND_TOKEN: "configured" })).resolves.not.toHaveProperty(
      "requirements",
    );
  });

  it("does not gate readiness on an auth-method-only provider", async () => {
    probePluginSetup.mockResolvedValueOnce(
      setupProbe({
        providers: [{ id: "oauth-only", authMethods: ["oauth"] }],
      }),
    );

    await expect(preflight()).resolves.not.toHaveProperty("requirements");
  });

  it("accepts declared local auth evidence", async () => {
    const credentialsDir = tempDirs.make("claw-auth-evidence-");
    const credentialsPath = join(credentialsDir, "credentials.json");
    await writeFile(credentialsPath, "{}", "utf8");
    probePluginSetup.mockResolvedValueOnce(
      setupProbe({
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
      }),
    );

    await expect(
      preflight({ EVIDENCE_CREDENTIALS: credentialsPath, EVIDENCE_PROJECT: "project" }),
    ).resolves.not.toHaveProperty("requirements");
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
    const installSkill = vi.fn(async (params: { beforePersistentApply?: () => void }) => {
      params.beforePersistentApply?.();
      return installedSkill;
    });
    const result = await installClawPackages(skillPlan(), {
      installSkill,
      preflightSkill: preflightSkill(),
    });

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
    expectReceipt(result, {
      integrity: skillIntegrity,
      relationship: "managed",
      origin: "claw-introduced",
    });
  });

  it("rejects an unreviewed skill warning before recording a ref or installing bytes", async () => {
    const planned = skillPlan("Review this skill.");
    const installSkill = vi.fn();

    await expect(
      installClawPackages(planned, {
        preflightSkill: preflightSkill("Review this skill."),
        installSkill,
      }),
    ).rejects.toMatchObject({ code: "skill_consent_required" });
    expect(installSkill).not.toHaveBeenCalled();
  });

  it("accepts only the reviewed skill warning at the installer trust check", async () => {
    const planned = skillPlan("Review this skill.");
    const skillConsent = { assertApproved: vi.fn() };
    const installSkill = vi.fn(
      async (params: { confirmInstall?: (warning?: string) => boolean | Promise<boolean> }) => {
        expect(await params.confirmInstall?.("Review this skill.")).toBe(true);
        expect(await params.confirmInstall?.("Changed trust warning.")).toBe(false);
        return installedSkill;
      },
    );

    await installClawPackages(
      planned,
      {
        preflightSkill: preflightSkill("Review this skill."),
        installSkill,
      },
      { skillConsent },
    );
    expect(skillConsent.assertApproved).toHaveBeenCalledWith({
      ref: "@owner/triage",
      version: "1.2.3",
      integrity: skillIntegrity,
      riskWarning: "Review this skill.",
    });
  });

  it("installs plugins through the shared surface with the selected ClawHub source", async () => {
    const stateDir = tempDirs.make("openclaw-claws-");
    const workerEnv = { OPENCLAW_STATE_DIR: stateDir };
    const installPlugin = vi.fn().mockResolvedValue(undefined);

    const result = await installClawPackages(
      plan([pluginPackage]),
      {
        installPlugin,
        probePlugin,
        preflightPlugin: preflightPlugin(),
      },
      { env: workerEnv, clawHubBaseUrl: "http://127.0.0.1:3323" },
    );

    expect(installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          source: "clawhub",
          packageName: "@owner/audit",
          version: "2.0.1",
          mode: "install",
          expectedIntegrity: integrity,
          expectedPluginId: "audit",
        },
        invalidateRuntimeCache: false,
        clawManaged: true,
        env: {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CLAWHUB_URL: "http://127.0.0.1:3323",
        },
      }),
    );
    expect(workerEnv).toEqual({ OPENCLAW_STATE_DIR: stateDir });
    expectReceipt(result, { integrity, relationship: "referenced", origin: "claw-introduced" });
  });

  it("records a dependency ref without reinstalling an exact reused plugin", async () => {
    const installPlugin = vi.fn();
    const probePluginForExtension = extensionProbe();

    const result = await installClawPackages(plan([{ ...pluginPackage, extension }], "reuse"), {
      installPlugin,
      probePlugin: withStagedInspection(probePluginForExtension),
      preflightPlugin: reusePlugin(),
    });

    expect(installPlugin).not.toHaveBeenCalled();
    expect(probePluginForExtension).toHaveBeenCalledWith(
      expect.objectContaining({ extensionsDir: expect.any(String) }),
    );
    expectReceipt(result, {
      integrity,
      extension,
      relationship: "referenced",
      origin: "pre-existing",
    });
  });

  it("rejects changed extension inspection before recording reused plugin provenance", async () => {
    await expect(
      installClawPackages(plan([{ ...pluginPackage, extension }], "reuse"), {
        installPlugin: vi.fn(),
        probePlugin: withStagedInspection(extensionProbe(["skills", "commands"])),
        preflightPlugin: reusePlugin(),
      }),
    ).rejects.toMatchObject({
      code: "package_owner_state_changed",
      message: expect.stringContaining("identity or trust state changed after planning"),
    });
  });

  it("marks the pending ref failed when a plugin install fails", async () => {
    await expect(
      installClawPackages(plan([pluginPackage]), {
        installPlugin: vi.fn().mockRejectedValue(new Error("registry unavailable")),
        probePlugin,
        preflightPlugin: preflightPlugin(),
      }),
    ).rejects.toMatchObject({
      code: "package_install_failed",
      message: "registry unavailable",
      installedPackages: [expect.objectContaining({ ref: "@owner/audit", status: "failed" })],
    });
  });

  it("invalidates consent when plugin owner state changes after planning", async () => {
    const installPlugin = vi.fn();

    await expect(
      installClawPackages(plan([pluginPackage]), {
        installPlugin,
        probePlugin,
        preflightPlugin: preflightPlugin("reuse"),
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it("invalidates consent when a skill trust warning changes after planning", async () => {
    const planned = skillPlan("review warning one");

    await expect(
      installClawPackages(planned, {
        preflightSkill: preflightSkill("review warning two"),
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
  });

  it("invalidates consent when a plugin trust warning changes after planning", async () => {
    const planned = plan([pluginPackage]);
    Object.assign(planned.actions[0]!.details!, { riskWarning: "review warning one" });

    await expect(
      installClawPackages(planned, {
        probePlugin: withStagedInspection(
          vi.fn().mockResolvedValue({
            ok: true,
            pluginId: "audit",
            warning: "review warning two",
            clawhub: { integrity },
          }),
        ),
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
  });
});
