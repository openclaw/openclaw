import { describe, expect, it, vi } from "vitest";
import {
  buildPluginCapabilityConsentReview,
  buildPluginCapabilitySummary,
  computeDeclaredSurfaceHash,
} from "../plugins/capability-summary.js";
import type { installManagedPlugin } from "../plugins/management-mutations.js";
import type { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import {
  installClawPackages,
  testPluginPackage as pkg,
  testPluginProbe,
  withStagedInspection,
  testPackageLease,
} from "./packages.boundary.test-support.js";
import { emptyPluginCapabilityEvidence, packageInstallPlan } from "./packages.test-support.js";
import { projectClawPluginCapabilityReviews } from "./plugin-capability-review.js";

const { integrity } = pkg;
const probePlugin = vi.fn(
  withStagedInspection(async () => testPluginProbe({ targetDir: "/tmp/audit" })),
);
const baseDeps = {
  probePlugin,
  inspectPluginCapabilities: () => emptyPluginCapabilityEvidence,
  preflightPlugin: vi.fn(async (params: Parameters<typeof preflightPluginInstall>[0]) => ({
    ok: true as const,
    action: "install" as const,
    request: { rawSpec: params.rawSpec, installKind: "plugin" as const },
  })),
  acquirePackageLease: vi.fn(async () => testPackageLease()),
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
        capabilityGrantsByPluginId: { audit: emptyPluginCapabilityEvidence.grants },
        reviewToken: computeDeclaredSurfaceHash(emptyPluginCapabilityEvidence.declared),
        riskWarning: "Review this plugin.",
      }),
    ]);
  });

  it.each([{ declaredCapabilities: { tools: ["audit.read"] } }, { integrity: undefined }])(
    "refuses incomplete plugin review evidence: %j",
    (missingEvidence) => {
      const planned = packageInstallPlan([pkg]);
      Object.assign(planned.actions[0]!.details!, missingEvidence);
      expect(() => projectClawPluginCapabilityReviews(planned)).toThrow(
        /incomplete review evidence/u,
      );
    },
  );

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

    await installClawPackages(packageInstallPlan([pkg]), {
      pluginConsent: { onCapabilityConsent },
      deps: {
        ...baseDeps,
        installPlugin,
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
    await expect(
      installClawPackages(packageInstallPlan([pkg]), {
        deps: { ...baseDeps, installPlugin },
      }),
    ).rejects.toMatchObject({ code: "plugin_consent_required" });
    expect(installPlugin).not.toHaveBeenCalled();
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

    await expect(
      installClawPackages(planned, {
        pluginConsent: {
          onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
        },
        deps: { ...baseDeps, installPlugin },
      }),
    ).rejects.toMatchObject({ code: "package_owner_state_changed" });
    expect(installPlugin).not.toHaveBeenCalled();
  });
});
