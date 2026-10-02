import { describe, expect, it, vi } from "vitest";
import {
  buildPluginCapabilityConsentReview,
  buildPluginCapabilitySummary,
  computeDeclaredSurfaceHash,
} from "../plugins/capability-summary.js";
import type { installPluginFromClawHub } from "../plugins/clawhub.js";
import type { installManagedPlugin } from "../plugins/management-mutations.js";
import type { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import { installClawPackages } from "./packages.js";
import { emptyPluginCapabilityEvidence, packageInstallPlan } from "./packages.test-support.js";
import { projectClawPluginCapabilityReviews } from "./plugin-capability-review.js";
import type { PersistedClawPackageRef } from "./provenance.js";

const integrity = `sha256:${"a".repeat(64)}`;
const pkg = {
  kind: "plugin" as const,
  source: "clawhub" as const,
  ref: "@owner/audit",
  version: "2.0.1",
  integrity,
};
const probePlugin = vi.fn(async (request: Parameters<typeof installPluginFromClawHub>[0]) => {
  await request.onPluginArtifactInspect?.({
    pluginId: "audit",
    stagedArtifactDir: "/tmp/staged-audit",
    mode: "install",
  });
  return {
    ok: true as const,
    pluginId: "audit",
    packageName: pkg.ref,
    targetDir: "/tmp/audit",
    extensions: [],
    clawhub: {
      source: "clawhub" as const,
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: pkg.ref,
      clawhubFamily: "code-plugin" as const,
      integrity,
    },
  };
});
const baseDeps = {
  probePlugin,
  inspectPluginCapabilities: () => emptyPluginCapabilityEvidence,
  preflightPlugin: vi.fn(async (params: Parameters<typeof preflightPluginInstall>[0]) => ({
    ok: true as const,
    action: "install" as const,
    request: { rawSpec: params.rawSpec, installKind: "plugin" as const },
  })),
  acquirePackageLease: vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() })),
};

describe("Claw plugin install consent", () => {
  it("projects integrity-bound review evidence for Gateway without installing", () => {
    const planned = packageInstallPlan([pkg]);
    Object.assign(planned.actions[0]!.details!, { riskWarning: "Review this plugin." });

    expect(projectClawPluginCapabilityReviews(planned)).toEqual([
      expect.objectContaining({
        actionId: "plugin:@owner/audit",
        pluginId: "audit",
        ref: pkg.ref,
        version: pkg.version,
        ownerAction: "install",
        integrity: `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`,
        declaredCapabilities: emptyPluginCapabilityEvidence.declared,
        capabilityGrants: emptyPluginCapabilityEvidence.grants,
        reviewToken: computeDeclaredSurfaceHash(emptyPluginCapabilityEvidence.declared),
        riskWarning: "Review this plugin.",
      }),
    ]);
  });

  it("refuses to project an unblocked plugin without complete capability evidence", () => {
    const planned = packageInstallPlan([pkg]);
    Object.assign(planned.actions[0]!.details!, {
      declaredCapabilities: { tools: ["audit.read"] },
    });

    expect(() => projectClawPluginCapabilityReviews(planned)).toThrow(
      /incomplete review evidence/u,
    );
  });

  it("refuses to project an unblocked plugin without artifact integrity", () => {
    const planned = packageInstallPlan([pkg]);
    Object.assign(planned.actions[0]!.details!, { integrity: undefined });

    expect(() => projectClawPluginCapabilityReviews(planned)).toThrow(
      /incomplete review evidence/u,
    );
  });

  it("passes exact Claw-owner capability consent into the canonical plugin installer", async () => {
    const review = buildPluginCapabilityConsentReview({
      pluginId: "audit",
      manifest: { name: "Audit" },
      record: { source: "clawhub", spec: "clawhub:@owner/audit@2.0.1", integrity },
      config: {},
    });
    const onCapabilityConsent = vi.fn(async (received: typeof review) => ({
      reviewToken: received.reviewToken,
    }));
    const installPlugin = vi.fn(async (params: Parameters<typeof installManagedPlugin>[0]) => {
      expect(params.clawManaged).toBe(true);
      expect(await params.onCapabilityConsent?.(review)).toEqual({
        reviewToken: review.reviewToken,
      });
    });
    const persistPackageRef = vi.fn(() => ({ status: "pending" }) as PersistedClawPackageRef);

    await installClawPackages(packageInstallPlan([pkg]), {
      pluginConsent: { onCapabilityConsent },
      deps: {
        ...baseDeps,
        installPlugin,
        persistPackageRef,
        completePackageRef: (ref, status) => ({ ...ref, status }),
      },
    });

    expect(installPlugin).toHaveBeenCalledOnce();
    expect(onCapabilityConsent).toHaveBeenCalledOnce();
    expect(onCapabilityConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "audit",
        reviewToken: review.reviewToken,
        declared: emptyPluginCapabilityEvidence.declared,
        grants: emptyPluginCapabilityEvidence.grants,
      }),
    );
  });

  it("stops Add before installer or record writes without Claw-owner consent", async () => {
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn();
    await expect(
      installClawPackages(packageInstallPlan([pkg]), {
        deps: { ...baseDeps, installPlugin, persistPackageRef },
      }),
    ).rejects.toMatchObject({ code: "plugin_consent_required" });
    expect(installPlugin).not.toHaveBeenCalled();
    expect(persistPackageRef).not.toHaveBeenCalled();
  });

  it("invalidates Add when an effective plugin grant is revoked after review", async () => {
    const planned = packageInstallPlan([pkg]);
    const reviewedGrants = buildPluginCapabilitySummary({
      manifest: {},
      origin: "global",
      entryConfig: { hooks: { allowConversationAccess: true } },
    }).grants;
    Object.assign(planned.actions[0]!.details!, { capabilityGrants: reviewedGrants });
    const installPlugin = vi.fn();
    const persistPackageRef = vi.fn();

    await expect(
      installClawPackages(planned, {
        pluginConsent: {
          onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
        },
        deps: { ...baseDeps, installPlugin, persistPackageRef },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
    expect(installPlugin).not.toHaveBeenCalled();
    expect(persistPackageRef).not.toHaveBeenCalled();
  });
});
