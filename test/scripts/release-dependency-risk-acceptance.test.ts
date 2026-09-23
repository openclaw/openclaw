import { describe, expect, it } from "vitest";
import { resolveReleaseDependencyRiskAcceptance } from "../../scripts/lib/release-dependency-risk-acceptance.mts";

describe("2026.9.5 operator dependency risk acceptance", () => {
  function acceptedAxiosRiskInput(): Parameters<typeof resolveReleaseDependencyRiskAcceptance>[0] {
    return {
      packageVersion: "2026.9.5",
      lockfileSha256: {
        "pnpm-lock.yaml": "ab6c244a27c09488e51e9d5879d84514fd0ac57b1db4e927d6a0464e598d543f",
        ".github/release/vercel-cli/package-lock.json":
          "a094a59287570aa124a65eb208739a5f4b89b7e8ffe768a3ac38842dd2e2dc85",
        ".github/release/clawhub-cli/package-lock.json":
          "30142b07c1167d030926f9dd3320a8b158aa59cbca5a56e05d949a50e6e2b3c6",
      },
      blockers: [
        {
          lockfile: "pnpm-lock.yaml",
          packageName: "axios",
          matchedVersions: ["1.20.0"],
          id: "GHSA-3pq3-5fj3-cg6v",
          severity: "high",
          graph: "production",
          malware: false,
          source: "github-repository",
          title: "HTTP/2 DNS and proxy policy",
          url: "https://github.com/axios/axios/security/advisories/GHSA-3pq3-5fj3-cg6v",
          vulnerableVersions: ">=1.13.0",
        },
      ],
    };
  }

  it("accepts only the approved 2026.9.5 Axios finding and unchanged graph", () => {
    const input = acceptedAxiosRiskInput();
    const original = structuredClone(input);
    expect(resolveReleaseDependencyRiskAcceptance(input)).toMatchObject({
      kind: "operator-accepted-dependency-risk",
      packageVersion: "2026.9.5",
      acceptedOn: "2026-09-17",
      lockfileSha256: original.lockfileSha256,
      blockers: original.blockers,
    });
    expect(input).toEqual(original);
  });

  it("does not extend the 2026.9.5 Axios exception to other risks or graph bytes", () => {
    const input = acceptedAxiosRiskInput();
    const [finding] = input.blockers;
    if (!finding) {
      throw new Error("Expected the single accepted Axios finding");
    }
    for (const packageVersion of ["2026.9.1", "2026.9.5-beta.1", "2026.9.6"]) {
      expect(resolveReleaseDependencyRiskAcceptance({ ...input, packageVersion })).toBeNull();
    }
    for (const file of Object.keys(input.lockfileSha256)) {
      expect(
        resolveReleaseDependencyRiskAcceptance({
          ...input,
          lockfileSha256: { ...input.lockfileSha256, [file]: "changed" },
        }),
      ).toBeNull();
    }
    const rejectedFindings: typeof input.blockers = [
      { ...finding, id: "GHSA-unaccepted" },
      { ...finding, packageName: "another-package" },
      { ...finding, matchedVersions: ["1.20.1"] },
      { ...finding, severity: "critical" },
      { ...finding, malware: true },
    ];
    for (const rejected of rejectedFindings) {
      expect(resolveReleaseDependencyRiskAcceptance({ ...input, blockers: [rejected] })).toBeNull();
    }
    expect(resolveReleaseDependencyRiskAcceptance({ ...input, blockers: [] })).toBeNull();
    expect(
      resolveReleaseDependencyRiskAcceptance({ ...input, blockers: [finding, finding] }),
    ).toBeNull();
    expect(
      resolveReleaseDependencyRiskAcceptance({
        ...input,
        blockers: [finding, { ...finding, id: "GHSA-additional" }],
      }),
    ).toBeNull();
  });
});
