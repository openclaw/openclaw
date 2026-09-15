import { describe, expect, it, vi } from "vitest";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
import { installPluginFromClawHub } from "../plugins/clawhub.js";
import { installClawPackages, preflightClawPackage } from "./packages.js";
import { packageInstallPlan } from "./packages.test-support.js";

const integrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const declaredCapabilities = {
  channels: [],
  providers: [],
  tools: ["audit.read"],
  contracts: [],
  hooks: [],
  mcpServers: [],
  cliCommands: [],
  cliBackends: [],
  skills: [],
  dangerousConfigFlags: [],
};
const capabilityGrants = {
  hooks: {
    allowPromptInjection: { effective: true },
    allowConversationAccess: { effective: false },
  },
};
const pluginPackage = {
  kind: "plugin",
  source: "clawhub",
  ref: "@owner/audit",
  version: "2.0.1",
  integrity,
} as const;

function plan() {
  const result = packageInstallPlan([pluginPackage], "install");
  const action = result.actions.find(
    (candidate) => candidate.kind === "package" && candidate.details?.kind === "plugin",
  );
  if (!action?.details) {
    throw new Error("Expected plugin package action.");
  }
  Object.assign(action.details, { declaredCapabilities, capabilityGrants });
  return result;
}

function successfulProbe() {
  return {
    ok: true as const,
    pluginId: "audit",
    packageName: "@owner/audit",
    targetDir: "/tmp/removed-after-probe",
    extensions: [],
    artifactInspection: {
      format: "openclaw" as const,
      mapped: ["plugin"],
      unavailable: [],
    },
    clawhub: {
      source: "clawhub" as const,
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "@owner/audit",
      clawhubFamily: "code-plugin" as const,
      integrity,
    },
  };
}

describe("Claw plugin capability evidence", () => {
  it("captures declared capabilities before dry-run staging is removed", async () => {
    const inspect = vi.fn(() => ({
      declared: declaredCapabilities,
      grants: capabilityGrants,
    }));
    const probe = vi.fn(async (request: Parameters<typeof installPluginFromClawHub>[0]) => {
      await request.onPluginArtifactInspect?.({
        pluginId: "audit",
        stagedArtifactDir: "/tmp/staged-audit",
        mode: "install",
      });

      return successfulProbe();
    });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        deps: {
          preflightPlugin: vi.fn(async () => ({
            ok: true as const,
            action: "install" as const,
            request: {} as never,
          })),
          probePlugin: probe,
          inspectPluginCapabilities: inspect,
        },
      }),
    ).resolves.toMatchObject({ ok: true, declaredCapabilities, capabilityGrants });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith(
      "/tmp/staged-audit",
      "audit",
      undefined,
      undefined,
      undefined,
    );
  });

  it("maps configured entries from the installed package during an isolated reuse probe", async () => {
    const inspect = vi.fn(() => ({
      declared: declaredCapabilities,
      grants: capabilityGrants,
    }));
    const probe = vi.fn(async (request: Parameters<typeof installPluginFromClawHub>[0]) => {
      await request.onPluginArtifactInspect?.({
        pluginId: "audit",
        stagedArtifactDir: "/tmp/staged-audit",
        mode: "install",
      });
      return successfulProbe();
    });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        deps: {
          preflightPlugin: vi.fn(async () => ({
            ok: true as const,
            action: "reuse" as const,
            request: {} as never,
            installedId: "audit",
            installedVersion: "2.0.1",
            installedPath: "/srv/openclaw/extensions/audit",
            installedIntegrity: integrity,
          })),
          probePlugin: probe,
          inspectPluginCapabilities: inspect,
        },
      }),
    ).resolves.toMatchObject({ ok: true, declaredCapabilities, capabilityGrants });
    expect(inspect).toHaveBeenCalledWith(
      "/tmp/staged-audit",
      "audit",
      undefined,
      undefined,
      "/srv/openclaw/extensions/audit",
    );
  });

  it("returns a structured failure when staged capability inspection throws", async () => {
    const probe = vi.fn(async (request: Parameters<typeof installPluginFromClawHub>[0]) => {
      await request.onPluginArtifactInspect?.({
        pluginId: "audit",
        stagedArtifactDir: "/tmp/staged-audit",
        mode: "install",
      });
      return successfulProbe();
    });

    await expect(
      preflightClawPackage(pluginPackage, "/tmp/workspace", {
        deps: {
          preflightPlugin: vi.fn(async () => ({
            ok: true as const,
            action: "install" as const,
            request: {} as never,
          })),
          probePlugin: probe,
          inspectPluginCapabilities: vi.fn(() => {
            throw new Error("malformed capability evidence");
          }),
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining(
        "capability inspection failed: malformed capability evidence",
      ),
    });
  });

  it("invalidates consent when the plugin-declared surface changes after planning", async () => {
    const installPlugin = vi.fn();

    await expect(
      installClawPackages(plan(), {
        deps: {
          installPlugin,
          probePlugin: vi.fn(async () => successfulProbe()),
          inspectPluginCapabilities: vi.fn(() => ({
            declared: { ...declaredCapabilities, tools: ["audit.write"] },
            grants: capabilityGrants,
          })),
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          acquirePackageLease: vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() })),
        },
      }),
    ).rejects.toMatchObject({
      code: "package_owner_state_changed",
      message: expect.stringContaining("identity or trust state changed after planning"),
    });
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it("rejects changed effective grants before the plugin owner commits", async () => {
    const installPlugin = vi.fn(async (params) => {
      await params.onCapabilityConsent?.({
        reviewToken: computeDeclaredSurfaceHash(declaredCapabilities),
        grants: {
          hooks: {
            allowPromptInjection: { effective: false },
            allowConversationAccess: { effective: false },
          },
        },
      });
    });
    const completePackageRef = vi.fn();

    await expect(
      installClawPackages(plan(), {
        deps: {
          installPlugin,
          probePlugin: vi.fn(async () => successfulProbe()),
          inspectPluginCapabilities: vi.fn(() => ({
            declared: declaredCapabilities,
            grants: capabilityGrants,
          })),
          preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
          persistPackageRef: vi.fn().mockReturnValue({
            schemaVersion: "openclaw.clawPackageRef.v1",
            agentId: "incident-2",
            clawName: "incident-claw",
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/audit",
            version: "2.0.1",
            integrity,
            status: "pending",
            relationship: "referenced",
            origin: "claw-introduced",
            independentOwner: false,
            installedAtMs: 1,
            updatedAtMs: 1,
          }),
          completePackageRef,
          acquirePackageLease: vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() })),
        },
      }),
    ).rejects.toMatchObject({
      code: "package_install_failed",
      message: expect.stringContaining("effective capability grants changed after planning"),
    });
    expect(completePackageRef).not.toHaveBeenCalledWith(
      expect.anything(),
      "complete",
      expect.anything(),
    );
  });
});
