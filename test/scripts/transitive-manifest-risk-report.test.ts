import { describe, expect, it } from "vitest";
import {
  createTransitiveManifestRiskReport,
  parseKnownRiskExceptions,
  renderTransitiveManifestRiskMarkdownReport,
} from "../../scripts/transitive-manifest-risk-report.mjs";

describe("transitive-manifest-risk-report", () => {
  it("validates known-risk exceptions without requiring process metadata", () => {
    expect(
      parseKnownRiskExceptions(`exceptions:
  - match:
      package: sharp
      version: 0.34.5
      script: install
    reason: Expected native install.
`).errors,
    ).toEqual([]);

    expect(
      parseKnownRiskExceptions(`exceptions:
  - match:
      package: sharp
    reason: Too broad.
`).errors,
    ).toEqual([
      "exceptions[0].match must include at least one precise discriminator besides package.",
    ]);

    expect(
      parseKnownRiskExceptions(`exceptions:
  - match:
      package: sharp
      script: install
`).errors,
    ).toEqual(["exceptions[0].reason must be a non-empty string."]);
  });

  it("reports floating transitive specs, lifecycle scripts, exotic sources, and recently published versions", async () => {
    const report = await createTransitiveManifestRiskReport({
      packageVersions: [
        { packageName: "parent", version: "1.0.0" },
        { packageName: "tarball-package", version: "https://example.test/pkg.tgz" },
      ],
      now: new Date("2026-05-12T00:00:00Z"),
      minimumReleaseAgeMinutes: 2_880,
      manifestLoader: async ({ packageName, version }) => {
        if (packageName !== "parent" || version !== "1.0.0") {
          throw new Error("unexpected manifest request");
        }
        return {
          publishedAt: "2026-05-11T23:00:00Z",
          manifest: {
            dependencies: {
              floating: "^1.2.3",
              exact: "2.0.0",
              gitdep: "github:owner/repo#main",
            },
            optionalDependencies: {
              optionalFloating: "~3.0.0",
            },
            scripts: {
              install: "node install.js",
            },
          },
        };
      },
    });

    expect(report.byType).toEqual({
      "exotic-source": 2,
      "floating-transitive-spec": 3,
      "lifecycle-script": 1,
      "recently-published-version": 1,
    });
    expect(report.workspaceExcludedFindings).toEqual([]);
    expect(report.metadataFailures).toEqual([]);
  });

  it("uses pnpm minimum release age exclusions for recently published versions", async () => {
    const report = await createTransitiveManifestRiskReport({
      packageVersions: [
        { packageName: "regular", version: "1.0.0" },
        { packageName: "exact-package", version: "2.0.0" },
        { packageName: "either-version", version: "5.102.1" },
        { packageName: "@scope/native-linux-x64", version: "3.0.0" },
      ],
      now: new Date("2026-05-12T00:00:00Z"),
      minimumReleaseAgeMinutes: 2_880,
      minimumReleaseAgeExclude: [
        "exact-package@2.0.0",
        "either-version@4.47.0 || 5.102.1",
        "@scope/native-*",
      ],
      manifestLoader: async () => ({
        publishedAt: "2026-05-11T23:00:00Z",
        manifest: {},
      }),
    });

    expect(report.byType).toEqual({
      "recently-published-version": 1,
    });
    expect(report.workspaceExcludedByType).toEqual({
      "recently-published-version": 3,
    });
    expect(report.findings).toMatchObject([
      {
        packageName: "regular",
        type: "recently-published-version",
      },
    ]);
    expect(report.workspaceExcludedFindings).toMatchObject([
      {
        packageName: "@scope/native-linux-x64",
        type: "recently-published-version",
        workspaceExcluded: true,
        workspaceExclusion: "@scope/native-*",
      },
      {
        packageName: "either-version",
        type: "recently-published-version",
        workspaceExcluded: true,
        workspaceExclusion: "either-version@4.47.0 || 5.102.1",
      },
      {
        packageName: "exact-package",
        type: "recently-published-version",
        workspaceExcluded: true,
        workspaceExclusion: "exact-package@2.0.0",
      },
    ]);
  });

  it("annotates matching known-risk exceptions and reports unused entries", async () => {
    const report = await createTransitiveManifestRiskReport({
      packageVersions: [{ packageName: "parent", version: "1.0.0" }],
      exceptions: [
        {
          match: {
            package: "parent",
            version: "1.0.0",
            dependency: { name: "floating", spec: "^1.2.3" },
          },
          reason: "Known upstream range.",
        },
        {
          match: { package: "other", version: "1.0.0" },
          reason: "No longer used.",
        },
      ],
      manifestLoader: async () => ({
        publishedAt: "2026-04-01T00:00:00Z",
        manifest: {
          dependencies: {
            floating: "^1.2.3",
          },
        },
      }),
    });

    expect(report.knownFindingCount).toBe(1);
    expect(report.findings).toMatchObject([
      {
        type: "floating-transitive-spec",
        known: true,
        reason: "Known upstream range.",
      },
    ]);
    expect(report.unusedExceptions).toMatchObject([
      {
        exception: {
          reason: "No longer used.",
        },
      },
    ]);
  });

  it("documents JSON completeness and renders grouped Markdown summaries", async () => {
    const report = await createTransitiveManifestRiskReport({
      packageVersions: [
        { packageName: "@earendil-works/pi-ai", version: "0.74.0" },
        { packageName: "aaa-package", version: "1.0.0" },
        { packageName: "recent-package", version: "1.0.0" },
      ],
      now: new Date("2026-05-12T00:00:00Z"),
      minimumReleaseAgeMinutes: 2_880,
      minimumReleaseAgeExclude: ["recent-package@1.0.0"],
      manifestLoader: async ({ packageName }) => ({
        publishedAt:
          packageName === "recent-package" ? "2026-05-11T23:00:00Z" : "2026-04-01T00:00:00Z",
        manifest:
          packageName === "@earendil-works/pi-ai"
            ? {
                dependencies: {
                  "@mistralai/mistralai": "^2.2.0",
                },
              }
            : packageName === "recent-package"
              ? {
                  dependencies: {
                    "recent-dependency": "^1.0.0",
                  },
                }
              : {
                  dependencies: {
                    "aaa-dependency": "^1.0.0",
                  },
                },
      }),
    });

    const markdown = renderTransitiveManifestRiskMarkdownReport(report);

    expect(markdown).toContain("# Transitive Manifest Risk Report");
    expect(markdown).toContain("## Scope");
    expect(markdown).toContain("published package manifests for resolved packages");
    expect(markdown).toContain("It is report-only.");
    expect(markdown).toContain("Resolved package versions inspected");
    expect(markdown).toContain("Actionable findings");
    expect(markdown).toContain("Signals covered by workspace policy exclusions");
    expect(markdown).toContain("## Actionable Findings By Type");
    expect(markdown).toContain("## Signals Covered By Workspace Policy Exclusions");
    expect(markdown).toContain("not included in the actionable finding totals");
    expect(markdown).toContain("## Complete Evidence");
    expect(markdown).toContain(
      "The complete actionable finding list is available in the JSON report",
    );
    expect(markdown).toContain("## Known Exception Summary");
    expect(markdown).toContain("## Published Package Manifests With Risk Findings");
    expect(markdown).toContain("`@earendil-works/pi-ai@0.74.0`: 1 manifest finding");
    expect(markdown).toContain("`aaa-package@1.0.0`: 1 manifest finding");
    expect(markdown).toContain("## Floating Dependency Targets");
    expect(markdown).toContain("`@mistralai/mistralai`: 1 declarations");
    expect(markdown).toContain("`aaa-dependency`: 1 declarations");
    expect(markdown).not.toContain("## Packages With Findings");
    expect(markdown).not.toContain("## Finding Details");
    expect(markdown).not.toContain("## Notable Findings");
    expect(markdown).not.toContain("## Additional Sample Findings");
  });
});
