import { describe, expect, it } from "vitest";
import {
  createDependencyRiskReport,
  parseKnownRiskExceptions,
  renderDependencyRiskMarkdownReport,
} from "../../scripts/dependency-risk-report.mjs";

describe("dependency-risk-report", () => {
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

  it("reports floating transitive specs, lifecycle scripts, exotic sources, and young packages", async () => {
    const report = await createDependencyRiskReport({
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
      "young-package": 1,
    });
    expect(report.metadataFailures).toEqual([]);
  });

  it("annotates matching known-risk exceptions and reports unused entries", async () => {
    const report = await createDependencyRiskReport({
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
    const report = await createDependencyRiskReport({
      packageVersions: [
        { packageName: "@earendil-works/pi-ai", version: "0.74.0" },
        { packageName: "aaa-package", version: "1.0.0" },
      ],
      manifestLoader: async ({ packageName }) => ({
        publishedAt: "2026-04-01T00:00:00Z",
        manifest:
          packageName === "@earendil-works/pi-ai"
            ? {
                dependencies: {
                  "@mistralai/mistralai": "^2.2.0",
                },
              }
            : {
                dependencies: {
                  "aaa-dependency": "^1.0.0",
                },
              },
      }),
    });

    const markdown = renderDependencyRiskMarkdownReport(report);

    expect(markdown).toContain("# Transitive Manifest Risk Report");
    expect(markdown).toContain("## Scope");
    expect(markdown).toContain("published package manifests for resolved packages");
    expect(markdown).toContain("It is report-only.");
    expect(markdown).toContain("Resolved package versions inspected");
    expect(markdown).toContain("## Complete Evidence");
    expect(markdown).toContain("The complete finding list is available in the JSON report");
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
