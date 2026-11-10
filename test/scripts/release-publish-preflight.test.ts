import { describe, expect, it, vi } from "vitest";
import {
  createPublicationSourceFact,
  publicationDispatchEnvelope,
  publicationIntentInputs,
  publicationSourceRequest,
  type PublicationSelection,
} from "../../scripts/full-release-publication-contract.mjs";
import { releaseExecutionPlanSha256 } from "../../scripts/full-release-validation-policy.mjs";
import { parsePublishPreflightArgs } from "../../scripts/lib/release-publish-preflight-interface.mts";
import { trustedMainNpmFixture } from "./release-ci-summary.test-support.js";

const version = "2026.11.5-beta.1";
const [targetSha, toolingSha] = ["a".repeat(40), "b".repeat(40)];
const workflowRef = "release-publish/bbbbbbbbbbbb-1";
let evidenceFixture: ReturnType<typeof extendedStableEvidence> | undefined;
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
    evidenceFixture?.parentRun ?? { status: "completed", conclusion: "success", run_attempt: 1 },
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
  inspectStableCloseoutPreflight: () => [],
}));
// mock-isolation: package inventory and GitHub run observation read live state.
vi.mock("../../scripts/lib/release-publish-state.mts", () => ({
  readReleasePublicationPackages: () => ({
    version: evidenceFixture ? "2026.9.37" : version,
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

// Replay retained source-admission evidence through the real strict authenticator;
// only GitHub/registry I/O is fixed, never the selection or provenance decision.
function extendedStableEvidence(mismatchedSelection = false) {
  const f = trustedMainNpmFixture("stable");
  const branch = "release-ci/" + toolingSha.slice(0, 12) + "-123";
  const mapped = <T>(value: T): T =>
    JSON.parse(
      JSON.stringify(value)
        .replaceAll("2026.8.28", "2026.9.37")
        .replaceAll(f.targetSha, targetSha)
        .replaceAll(f.workflowSha, toolingSha)
        .replaceAll('"main"', JSON.stringify(branch))
        .replaceAll("refs/heads/main", "refs/heads/" + branch),
    );
  const selection: PublicationSelection = {
    route: mismatchedSelection ? "normal" : "extended-stable",
    npmDistTag: mismatchedSelection ? "latest" : "extended-stable",
    publishOpenclawNpm: true,
    pluginPublishScope: "all-publishable",
    plugins: [],
  };
  const source = createPublicationSourceFact(
    publicationSourceRequest({
      PUBLICATION_INPUTS_JSON: JSON.stringify({
        ref: targetSha,
        trusted_workflow_json: publicationDispatchEnvelope(null, {
          validationPurpose: "publish",
          publicationSelection: selection,
        }),
        release_profile: "stable",
        rerun_group: "all",
        run_release_soak: "true",
      }),
      PUBLICATION_TARGET_CONTEXT: "extended-stable/2026.9.33",
      PUBLICATION_TOOLING_JSON: JSON.stringify({
        fullRef: "refs/heads/" + branch,
        sha: toolingSha,
      }),
      PUBLICATION_TARGET_SHA: targetSha,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_REF: "refs/heads/" + branch,
      GITHUB_SHA: toolingSha,
      GITHUB_RUN_ID: f.runId,
      GITHUB_RUN_ATTEMPT: "1",
    }),
    { packages: [], platforms: [] },
    {
      version: "2026.9.37",
      packages: [{ name: "openclaw", version: "2026.9.37", targets: ["npm"] }],
      platforms: [],
    },
  );
  const manifest = mapped(f.manifest);
  const plan = mapped(f.executionPlan);
  // This archived source-admission producer predates reduced npm coverage.
  delete plan.coveragePolicy;
  Object.assign(manifest, {
    sourceAdmissionContract: "1",
    sourceAdmission: source,
    targetRef: targetSha,
    trustedWorkflow: { fullRef: "refs/heads/" + branch, ref: branch, sha: toolingSha },
  });
  Object.assign(
    manifest.validationInputs,
    Object.fromEntries(
      Object.entries(source.coverage).map(([key, value]) => [
        key.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase()),
        value,
      ]),
    ),
  );
  delete manifest.validationInputs.coveragePolicy;
  Object.assign(manifest.validationInputs, publicationIntentInputs(source), {
    targetContextRef: source.targetContextRef,
  });
  Object.assign(plan, { sourceAdmissionContract: "1", sourceAdmission: source });
  plan.sha256 = releaseExecutionPlanSha256(plan);
  manifest.executionPlanSha256 = plan.sha256;
  return {
    parentRun: { ...mapped(f.parentRun), name: "Full Release Validation" },
    manifest,
    client: {
      ...f.client,
      getWorkflowSource: () => 'env:\n  FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1"\n',
      getRef: (ref: string) => ({ ref, object: { sha: toolingSha } }),
      getRun: (id: string) => ({
        ...mapped(f.client.getRun(id)),
        ...(id === f.runId ? { name: "Full Release Validation" } : {}),
      }),
      getRunView: (id: string) => mapped(f.client.getRunView(id)),
      getParentJobs: (id: string) => mapped(f.client.getParentJobs(id)),
      getRunAttemptJobs: (id: string) => mapped(f.client.getRunAttemptJobs(id)),
      getJobLog: (id: number) =>
        f.client
          .getJobLog(id)
          .replaceAll(f.targetSha, targetSha)
          .replaceAll("CI_RELEASE_SCOPE: npm-stable", "CI_RELEASE_SCOPE: full"),
      loadManifest: () => ({ artifact: mapped(f.artifact), manifest }),
      loadExecutionPlan: () => plan,
    },
  };
}

describe("extended-stable publication preflight", () => {
  it.each(["exact", "prepared", "mismatched seal"] as const)(
    "authenticates extended-stable selection: %s",
    async (scenario) => {
      const publicationRoute = scenario === "prepared" ? "prepared" : undefined;
      vi.spyOn(console, "error").mockImplementation(() => {});
      evidenceFixture = extendedStableEvidence(scenario === "mismatched seal");
      vi.stubGlobal("fetch", async (url: string) =>
        url.endsWith("/2026.9.37")
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
          tag: "v2026.9.37",
          npmDistTag: "extended-stable",
          pluginPublishScope: "all-publishable",
          workflowRef,
          fullReleaseValidationRunId: String(evidenceFixture.parentRun.id),
          fullReleaseValidationRunAttempt: "1",
          publicationRoute,
        });
        expect(report.rows.find((row) => row.id === "dispatch.inputs")?.status).toBe("PASS");
        if (scenario === "exact") {
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
