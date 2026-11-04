import { afterEach, describe, expect, it, vi } from "vitest";

const version = "2026.11.5-beta.1";
const targetSha = "a".repeat(40);
const toolingSha = "b".repeat(40);
const workflowRef = "release-publish/bbbbbbbbbbbb-1";
const originalPublisherRunId = "41760000001";

const verifyOpenClawNpmResumeRun = vi.fn(async () => ({ runId: originalPublisherRunId }));

// Unrelated GitHub, artifact and identity owners are fixtures; the registry is the
// live fetch boundary that decides whether the core package needs a resume.
vi.mock("../../scripts/lib/release-publish-preflight-evidence.mts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../scripts/lib/release-publish-preflight-evidence.mts")
  >()),
  createPublishPreflightGh: () => () => {
    throw new Error("unexpected gh call");
  },
  createPublishPreflightEvidenceClient: () => ({ loadManifest: () => null }),
  preflightApi: () => ({ status: "completed", conclusion: "success", run_attempt: 1 }),
  resolvePreflightTag: (_runGh: unknown, _repo: string, tag: string) =>
    tag.startsWith("release-publish/") ? toolingSha : targetSha,
  verifyPublishSourceLineage: () => undefined,
  validatePublishPreflightNpm: async () => ({ manifest: { tarballSha256: "c".repeat(64) } }),
  verifyPublishedPreflightTarball: async () => "d".repeat(128),
}));
vi.mock("../../scripts/npm-preflight-tooling-identity.mjs", () => ({
  verifyReleasePreflightToolingIdentity: () => undefined,
}));
vi.mock("../../scripts/lib/release-publish-closeout-preflight.mts", () => ({
  inspectPublishReleasePage: () => undefined,
  inspectStableCloseoutPreflight: () => [],
}));
vi.mock("../../scripts/lib/release-publish-state.mts", () => ({
  readReleasePublicationPackages: () => ({ version, corePackages: [], npmPlugins: [] }),
  // FRV sealed this decision before publication, so it still reports "plan".
  observeReleaseNpmState: async () => ({
    gates: [],
    bootstrapCandidates: [],
    publishedPackages: [],
  }),
  observeReleaseGitHubState: () => ({ gates: [] }),
}));
vi.mock("../../scripts/openclaw-npm-resume-run.mts", () => ({ verifyOpenClawNpmResumeRun }));

const { runReleasePublishPreflight } = await import("../../scripts/release-publish-preflight.mts");

afterEach(() => {
  vi.unstubAllGlobals();
  verifyOpenClawNpmResumeRun.mockClear();
});

describe("release publish preflight core npm resume", () => {
  it.each([true, false])(
    "reads the live registry for the resume run when published=%s",
    async (published) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          if (input.includes("/-/npm/v1/attestations/")) {
            return Response.json({ attestations: [] });
          }
          if (input.endsWith(`/openclaw/${version}`)) {
            return new Response("{}", { status: 404 });
          }
          return Response.json({
            name: "openclaw",
            "dist-tags": { beta: "2026.11.4-beta.1" },
            versions: {
              "2026.11.4-beta.1": {},
              ...(published ? { [version]: {} } : {}),
            },
          });
        }),
      );

      const report = await runReleasePublishPreflight(
        {
          repo: "openclaw/openclaw",
          tag: `v${version}`,
          fullReleaseValidationRunId: "111",
          fullReleaseValidationRunAttempt: "1",
          preflightRunId: "111",
          npmDistTag: "beta",
          pluginPublishScope: "all-publishable",
          workflowRef,
          publishOpenclawNpm: true,
        },
        { targetSha, toolingSha },
      );

      expect(report.command).toContain(`--ref ${workflowRef}`);
      if (published) {
        expect(report.command).toContain(`-f openclaw_npm_resume_run_id=${originalPublisherRunId}`);
        expect(report.rows).toContainEqual(
          expect.objectContaining({ id: "core-npm.resume", status: "PASS" }),
        );
      } else {
        expect(report.command).not.toContain("openclaw_npm_resume_run_id");
        expect(verifyOpenClawNpmResumeRun).not.toHaveBeenCalled();
      }
    },
  );
});
