import { describe, expect, it, vi } from "vitest";
import { parsePublishPreflightArgs } from "../../scripts/lib/release-publish-preflight-interface.mts";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";

const version = "2026.11.5-beta.1";
const [targetSha, toolingSha] = ["a".repeat(40), "b".repeat(40)];
const workflowRef = "release-publish/bbbbbbbbbbbb-1";
let evidenceFixture: ReturnType<typeof candidatePublicationFixture> | undefined;
const resumeRun = vi.fn(async () => ({ runId: "41760000001" }));

// Unrelated GitHub, artifact and identity owners are fixtures; the stubbed registry
// fetch is the live boundary that decides whether core npm needs a resume.
vi.mock("../../scripts/lib/release-publish-preflight-evidence.mts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPublishPreflightGh: () => () => {
    throw new Error("unexpected gh call");
  },
  createPublishPreflightEvidenceClient: () =>
    evidenceFixture?.client ?? { loadManifest: () => null },
  preflightApi: () =>
    evidenceFixture?.parent ?? { status: "completed", conclusion: "success", run_attempt: 1 },
  resolvePreflightTag: (_gh: unknown, _repo: string, tag: string) =>
    tag.startsWith("release-publish/") ? toolingSha : targetSha,
  verifyPublishSourceLineage: () => undefined,
  validatePublishPreflightNpm: async () => ({ manifest: { tarballSha256: "c".repeat(64) } }),
  verifyPublishedPreflightTarball: async () => "d".repeat(128),
}));
// mock-isolation: protected tooling identity reads live GitHub refs.
vi.mock("../../scripts/npm-preflight-tooling-identity.mjs", () => ({
  verifyReleasePreflightToolingIdentity: () => undefined,
}));
// mock-isolation: release-page admission reads the live GitHub release.
vi.mock("../../scripts/lib/release-publish-closeout-preflight.mts", () => ({
  inspectPublishReleasePage: () => undefined,
  inspectStableCloseoutPreflight: () => [
    {
      id: "stable-closeout.fixture",
      status: "WARN",
      message: "Regular stable closeout",
      remediation: "",
    },
  ],
}));
// mock-isolation: package inventory and GitHub run observation read live state.
vi.mock("../../scripts/lib/release-publish-state.mts", () => ({
  readReleasePublicationPackages: () => ({
    version: evidenceFixture ? "2026.9.38" : version,
    corePackages: [],
    npmPlugins: [],
  }),
  // FRV sealed this decision before publication, so it still reports "plan".
  observeReleaseNpmState: async () => ({ gates: [], bootstrapCandidates: [] }),
  observeReleaseGitHubState: () => ({ gates: [] }),
}));
// mock-isolation: publisher discovery verifies live Sigstore provenance.
vi.mock("../../scripts/openclaw-npm-resume-run.mts", () => ({
  verifyOpenClawNpmResumeRun: resumeRun,
}));
const { runReleasePublishPreflight } = await import("../../scripts/release-publish-preflight.mts");

describe("release publish preflight core npm resume", () => {
  it.each([true, false])("reads the live registry when published=%s", async (published) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    resumeRun.mockClear();
    const versions = { "2026.11.4-beta.1": {}, ...(published ? { [version]: {} } : {}) };
    vi.stubGlobal("fetch", async (url: string) =>
      url.includes("/attestations/")
        ? Response.json({ attestations: [] })
        : url.endsWith(`/${version}`)
          ? new Response("{}", { status: 404 })
          : Response.json({
              name: "openclaw",
              "dist-tags": { beta: "2026.11.4-beta.1" },
              versions,
            }),
    );
    const options = parsePublishPreflightArgs([
      "--tag",
      `v${version}`,
      "--workflow-ref",
      workflowRef,
      "--full-release-validation-run-id",
      "111",
      "--full-release-validation-run-attempt",
      "1",
    ])?.options;
    if (!options) {
      throw new Error("Expected parsed preflight options");
    }
    expect(options.retiredLinePublicationReason).toBeUndefined();
    const report = await runReleasePublishPreflight(options, { targetSha, toolingSha });
    expect(report.rows.find((row) => row.id === "dispatch.inputs")?.status).toBe("PASS");
    expect(report.command).toContain(`--ref ${workflowRef}`);
    expect(report.command.includes("-f openclaw_npm_resume_run_id=41760000001")).toBe(published);
    expect(resumeRun).toHaveBeenCalledTimes(published ? 1 : 0);
    vi.unstubAllGlobals();
  });
});

describe("extended-stable publication preflight", () => {
  it.each(["exact", "prepared", "mismatched seal"] as const)(
    "authenticates extended-stable selection: %s",
    async (scenario) => {
      const publicationRoute = scenario === "prepared" ? "prepared" : undefined;
      vi.spyOn(console, "error").mockImplementation(() => {});
      // Use a synthetic extended-stable version without a release-specific exemption.
      evidenceFixture = candidatePublicationFixture({
        candidateVersion: "2026.9.38",
        targetContextRef: "extended-stable/2026.9.33",
        qualificationBaselines: {
          upgradeBaseline: "openclaw@2026.9.36",
          upgradeSurvivorBaselines: ["openclaw@2026.9.33", "openclaw@2026.9.36"],
        },
        publicationRoute: scenario === "mismatched seal" ? "normal" : "extended-stable",
      });
      vi.stubGlobal("fetch", async (url: string) =>
        url.endsWith("/2026.9.38")
          ? new Response("{}", { status: 404 })
          : Response.json({
              name: "openclaw",
              "dist-tags": { "extended-stable": "2026.9.36" },
              versions: { "2026.9.36": {} },
            }),
      );
      try {
        const report = await runReleasePublishPreflight({
          repo: "openclaw/openclaw",
          tag: "v2026.9.38",
          npmDistTag: "extended-stable",
          pluginPublishScope: "all-publishable",
          workflowRef,
          fullReleaseValidationRunId: evidenceFixture.runId,
          fullReleaseValidationRunAttempt: "1",
          publicationRoute,
        });
        expect(report.rows.find((row) => row.id === "dispatch.inputs")?.status).toBe("PASS");
        if (scenario === "exact") {
          expect(report.rows.filter((row) => row.id.startsWith("stable-closeout."))).toEqual([]);
          expect(
            report.failed,
            JSON.stringify(report.rows.filter((row) => row.status === "FAIL")),
          ).toBe(false);
        }
        const provenance = report.rows.find((row) => row.id === "validation.provenance");
        expect(provenance, JSON.stringify(provenance)).toMatchObject(
          scenario === "prepared"
            ? { status: "FAIL", message: "publication route and npm dist-tag disagree" }
            : scenario === "mismatched seal"
              ? {
                  status: "FAIL",
                  message:
                    "New-contract nonpublish or differently selected evidence cannot prepare publication.",
                }
              : { status: "PASS" },
        );
      } finally {
        evidenceFixture = undefined;
        vi.unstubAllGlobals();
      }
    },
  );
});

it.each([
  [
    "Approved security backport to the retired September line.",
    "A retired-line decision requires the extended-stable npm dist-tag.",
  ],
  [
    "Invalid\nmultiline reason",
    "Retired-line publication requires a single-line maintainer reason of at most 1000 characters.",
  ],
])(
  "rejects invalid retirement input before observing remote state: %s",
  async (reason, message) => {
    const options = parsePublishPreflightArgs([
      "--tag",
      `v${version}`,
      "--workflow-ref",
      workflowRef,
      "--full-release-validation-run-id",
      "111",
      "--retired-line-publication-reason",
      reason,
    ])?.options;
    if (!options) {
      throw new Error("Expected parsed preflight options");
    }
    const report = await runReleasePublishPreflight(options);
    expect(report.rows).toEqual([
      {
        id: "dispatch.inputs",
        status: "FAIL",
        message,
        remediation: "Correct the named dispatch inputs and repeat preflight.",
      },
    ]);
  },
);
