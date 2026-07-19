import { describe, expect, it, vi } from "vitest";
import { installClawPackages } from "./packages.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import type { ClawAddPlan, ResolvedClawPackage } from "./types.js";

function plan(
  packages: ResolvedClawPackage[],
  ownerAction: "install" | "reuse" = "install",
): ClawAddPlan {
  return {
    schemaVersion: "openclaw.clawAddPlan.v1",
    manifestSchemaVersion: 1,
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:plan",
    claw: {
      kind: "package",
      name: "incident-claw",
      version: "1.0.0",
      packageRoot: "/tmp/claw",
      manifestPath: "/tmp/claw/claw.json",
      integrityKind: "artifact",
      integrity: "sha256:claw",
      byteLength: 123,
    },
    agent: {
      requestedId: "incident",
      finalId: "incident-2",
      workspace: "/tmp/incident-2",
      config: { id: "incident-2", workspace: "/tmp/incident-2" },
    },
    summary: {
      totalActions: packages.length,
      agentActions: 0,
      workspaceActions: 0,
      packageActions: packages.length,
      mcpServerActions: 0,
      cronJobActions: 0,
      blockedActions: 0,
      capabilityEscalations: 0,
    },
    actions: packages.map((pkg) => ({
      kind: "package",
      id: `${pkg.kind}:${pkg.ref}`,
      action: "install",
      target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
      details: {
        ...pkg,
        ownerAction,
        ...(pkg.kind === "plugin" ? { installId: pkg.ref.split("/").at(-1) } : {}),
      },
      blocked: false,
    })),
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
}

const completePackageRef = vi.fn(
  (ref: PersistedClawPackageRef, status: PersistedClawPackageRef["status"]) => ({
    ...ref,
    status,
  }),
);

const pluginIntegrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const probePlugin = vi.fn(async ({ spec }: { spec: string }) => {
  const pluginId = spec.slice(spec.lastIndexOf("/") + 1).split("@")[0]!;
  return {
    ok: true as const,
    pluginId,
    targetDir: "/tmp/plugin",
    extensions: [],
    clawhub: { integrity: pluginIntegrity },
  };
});

describe("installClawPackages", () => {
  it("installs skill packages into the planned workspace with the resolved digest", async () => {
    const integrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const pending = { kind: "skill", ref: "@owner/triage", status: "pending", integrity };
    const installSkill = vi.fn().mockResolvedValue({
      ok: true,
      slug: "triage",
      version: "1.2.3",
      targetDir: "/tmp/incident-2/skills/triage",
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
          integrity,
        },
      ]),
      {
        deps: {
          installSkill,
          preflightSkill: vi.fn().mockResolvedValue({ ok: true, action: "install", integrity }),
          persistPackageRef,
          completePackageRef,
        },
        onExternalMutation,
      },
    );

    expect(installSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/incident-2",
        slug: "@owner/triage",
        version: "1.2.3",
        expectedIntegrity: integrity,
      }),
    );
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ integrity }),
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

  it("installs plugins through the shared plugin surface", async () => {
    const installPlugin = vi.fn().mockResolvedValue(undefined);
    const persistPackageRef = vi.fn().mockReturnValue({
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const preflightPlugin = vi.fn().mockResolvedValue({ ok: true, action: "install" });

    await installClawPackages(
      plan([
        {
          kind: "plugin",
          source: "clawhub",
          ref: "@owner/audit",
          version: "2.0.1",
          integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      ]),
      {
        deps: {
          installPlugin,
          probePlugin,
          preflightPlugin,
          persistPackageRef,
          completePackageRef,
        },
      },
    );

    expect(installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: "clawhub:@owner/audit@2.0.1",
        opts: {
          acknowledgeClawHubRisk: true,
          expectedIntegrity:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          expectedPluginId: "audit",
        },
        invalidateRuntimeCache: false,
      }),
    );
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

  it("records a dependency ref without reinstalling an exact reused plugin", async () => {
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn().mockReturnValue({ kind: "plugin" });
    const preflightPlugin = vi.fn().mockResolvedValue({
      ok: true,
      action: "reuse",
      installedId: "audit",
      installedIntegrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    await installClawPackages(
      plan(
        [
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/audit",
            version: "2.0.1",
            integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
        "reuse",
      ),
      {
        deps: {
          installPlugin,
          probePlugin,
          preflightPlugin,
          persistPackageRef,
          completePackageRef,
        },
      },
    );

    expect(installPlugin).not.toHaveBeenCalled();
    expect(persistPackageRef).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      expect.objectContaining({
        status: "complete",
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
      integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    } as PersistedClawPackageRef;
    const persistPackageRef = vi.fn().mockReturnValue(pending);

    await expect(
      installClawPackages(
        plan([
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/audit",
            version: "2.0.1",
            integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ]),
        {
          deps: {
            installPlugin: vi.fn().mockRejectedValue(new Error("registry unavailable")),
            probePlugin,
            preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
            persistPackageRef,
            completePackageRef,
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "package_install_failed",
      message: "registry unavailable",
      installedPackages: [expect.objectContaining({ ref: "@owner/audit", status: "failed" })],
    });
  });

  it("removes a newly installed plugin when a later package fails", async () => {
    const integrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const installPlugin = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second install failed"));
    const uninstallPlugin = vi.fn().mockResolvedValue(undefined);
    const refs = [
      { kind: "plugin", ref: "@owner/first", status: "pending", integrity },
      { kind: "plugin", ref: "@owner/second", status: "pending", integrity },
    ] as PersistedClawPackageRef[];
    const persistPackageRef = vi.fn().mockReturnValueOnce(refs[0]).mockReturnValueOnce(refs[1]);

    await expect(
      installClawPackages(
        plan([
          { kind: "plugin", source: "clawhub", ref: "@owner/first", version: "1.0.0", integrity },
          { kind: "plugin", source: "clawhub", ref: "@owner/second", version: "1.0.0", integrity },
        ]),
        {
          deps: {
            installPlugin,
            uninstallPlugin,
            probePlugin,
            preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
            persistPackageRef,
            completePackageRef,
            readPackageRefs: vi.fn().mockReturnValue([]),
          },
        },
      ),
    ).rejects.toMatchObject({ code: "package_install_failed", message: "second install failed" });

    expect(uninstallPlugin).toHaveBeenCalledWith(
      "first",
      { force: true, invalidateRuntimeCache: false },
      expect.anything(),
    );
    expect(completePackageRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "@owner/first" }),
      "rolled_back",
      expect.anything(),
    );
  });

  it("preserves the installer error when failure provenance cannot be updated", async () => {
    const pending = {
      kind: "plugin",
      ref: "@owner/audit",
      status: "pending",
      integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    } as PersistedClawPackageRef;
    const failingCompletePackageRef = vi.fn(() => {
      throw new Error("state database unavailable");
    });

    await expect(
      installClawPackages(
        plan([
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/audit",
            version: "2.0.1",
            integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ]),
        {
          deps: {
            installPlugin: vi.fn().mockRejectedValue(new Error("registry unavailable")),
            probePlugin,
            preflightPlugin: vi.fn().mockResolvedValue({ ok: true, action: "install" }),
            persistPackageRef: vi.fn().mockReturnValue(pending),
            completePackageRef: failingCompletePackageRef,
          },
        },
      ),
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
      installClawPackages(
        plan([
          {
            kind: "plugin",
            source: "clawhub",
            ref: "@owner/audit",
            version: "2.0.1",
            integrity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ]),
        {
          deps: {
            installPlugin,
            probePlugin,
            preflightPlugin,
            persistPackageRef,
            completePackageRef,
          },
        },
      ),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
    expect(installPlugin).not.toHaveBeenCalled();
    expect(persistPackageRef).not.toHaveBeenCalled();
  });

  it("invalidates consent when a skill trust warning changes after planning", async () => {
    const integrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const planned = plan([
      { kind: "skill", source: "clawhub", ref: "@owner/triage", version: "1.2.3", integrity },
    ]);
    Object.assign(planned.actions[0]!.details!, { riskWarning: "review warning one" });

    await expect(
      installClawPackages(planned, {
        deps: {
          preflightSkill: vi.fn().mockResolvedValue({
            ok: true,
            action: "install",
            integrity,
            warning: "review warning two",
          }),
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
  });

  it("invalidates consent when a plugin trust warning changes after planning", async () => {
    const planned = plan([
      {
        kind: "plugin",
        source: "clawhub",
        ref: "@owner/audit",
        version: "2.0.1",
        integrity: pluginIntegrity,
      },
    ]);
    Object.assign(planned.actions[0]!.details!, { riskWarning: "review warning one" });

    await expect(
      installClawPackages(planned, {
        deps: {
          probePlugin: vi.fn().mockResolvedValue({
            ok: true,
            pluginId: "audit",
            warning: "review warning two",
            clawhub: { integrity: pluginIntegrity },
          }),
        },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
  });
});
