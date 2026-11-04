import { describe, expect, it, vi } from "vitest";

const version = "2026.11.5-beta.1";
const [targetSha, toolingSha] = ["a".repeat(40), "b".repeat(40)];
const workflowRef = "release-publish/bbbbbbbbbbbb-1";
const resumeRun = vi.fn(async () => ({ runId: "41760000001" }));

// Unrelated GitHub, artifact and identity owners are fixtures; the stubbed registry
// fetch is the live boundary that decides whether core npm needs a resume.
vi.mock("../../scripts/lib/release-publish-preflight-evidence.mts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPublishPreflightGh: () => () => {
    throw new Error("unexpected gh call");
  },
  createPublishPreflightEvidenceClient: () => ({ loadManifest: () => null }),
  preflightApi: () => ({ status: "completed", conclusion: "success", run_attempt: 1 }),
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
}));
// mock-isolation: package inventory and GitHub run observation read live state.
vi.mock("../../scripts/lib/release-publish-state.mts", () => ({
  readReleasePublicationPackages: () => ({ version, corePackages: [], npmPlugins: [] }),
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
    const report = await runReleasePublishPreflight(
      {
        repo: "openclaw/openclaw",
        tag: `v${version}`,
        fullReleaseValidationRunId: "111",
        fullReleaseValidationRunAttempt: "1",
        npmDistTag: "beta",
        pluginPublishScope: "all-publishable",
        workflowRef,
      },
      { targetSha, toolingSha },
    );
    expect(report.command).toContain(`--ref ${workflowRef}`);
    expect(report.command.includes("-f openclaw_npm_resume_run_id=41760000001")).toBe(published);
    expect(resumeRun).toHaveBeenCalledTimes(published ? 1 : 0);
    vi.unstubAllGlobals();
  });
});
