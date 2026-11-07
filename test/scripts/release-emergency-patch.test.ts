import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  qualifyEmergencyPatch,
  selectEmergencyPatchApproval,
} from "../../scripts/release-emergency-patch.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const root = dirs.make("emergency-patch-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@example.test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", root);
  const commit = (text: string) => {
    writeFileSync(join(root, "patch.txt"), text);
    git("add", ".");
    git("commit", "-qm", "patch");
    return git("rev-parse", "HEAD");
  };
  const baseSha = commit("base\n");
  const candidateSha = commit("base\nsecurity fix\n");
  const approval = {
    releaseTag: "v2026.11.2",
    baseTag: "v2026.11.1",
    baseSha,
    candidateSha,
    reason: "Emergency security fix; release manager accepts omitted validation.",
  };
  const input = {
    root,
    policy: { version: 1, approvals: [approval] },
    releaseTag: approval.releaseTag,
    npmDistTag: "latest",
    expectedSha: candidateSha,
    registryReader: async () => ({
      ok: true,
      status: 200,
      packument: { "dist-tags": { latest: "2026.11.1" } },
    }),
    readApi: (path: string) => {
      if (path.startsWith("git/ref/")) {
        return {
          object: {
            type: "tag",
            sha: path.endsWith(approval.baseTag) ? baseSha : approval.candidateSha,
          },
        };
      }
      const base = path.endsWith(baseSha);
      return {
        tag: base ? approval.baseTag : approval.releaseTag,
        object: { type: "commit", sha: base ? baseSha : approval.candidateSha },
        verification: { verified: true },
      };
    },
  };
  return { input, approval, commit };
}

describe("emergency patch admission", () => {
  it("qualifies the complete signed small delta, recording omissions rather than passes", async () => {
    const { input } = fixture();
    const result = await qualifyEmergencyPatch(input);
    expect(result.mode).toBe("emergency-patch-v1");
    expect(result.delta).toMatchObject({
      commits: 1,
      lines: 1,
      files: [{ path: "patch.txt", added: 1, deleted: 0 }],
    });
    expect(result.skipped).toContain("soak");
    expect(result.skipped).toContain("full-release-validation");
    expect(result).not.toHaveProperty("conclusion", "success");
  });

  it("refuses unapproved, mismatched, stale-baseline, or unsigned candidates", async () => {
    const { input } = fixture();
    expect(() =>
      selectEmergencyPatchApproval({ version: 1, approvals: [] }, input.releaseTag, "latest"),
    ).toThrow("approval");
    expect(() => selectEmergencyPatchApproval(input.policy, input.releaseTag, "beta")).toThrow(
      "stable/latest",
    );
    await expect(qualifyEmergencyPatch({ ...input, expectedSha: "f".repeat(40) })).rejects.toThrow(
      "target differs",
    );
    await expect(
      qualifyEmergencyPatch({
        ...input,
        registryReader: async () => ({
          ok: true,
          status: 200,
          packument: { "dist-tags": { latest: "2026.11.3" } },
        }),
      }),
    ).rejects.toThrow("baseline");
    await expect(
      qualifyEmergencyPatch({ ...input, readApi: () => ({ object: { type: "commit" } }) }),
    ).rejects.toThrow("signed");
  });

  it("counts all commits and all changed lines, not just nominated fixes", async () => {
    const { input, approval, commit } = fixture();
    approval.candidateSha = commit("base\nsecurity fix\n" + "extra\n".repeat(501));
    input.expectedSha = approval.candidateSha;
    await expect(qualifyEmergencyPatch(input)).rejects.toThrow("small-patch budget");
    approval.candidateSha = commit("small again\n");
    approval.candidateSha = commit("another change\n");
    input.expectedSha = approval.candidateSha;
    await expect(qualifyEmergencyPatch(input)).rejects.toThrow("small-patch budget");
  });

  it("qualifies depth-one publication checkouts and exact already-published recovery", async () => {
    const { input } = fixture();
    const root = dirs.make("emergency-shallow-");
    execFileSync("git", ["clone", "--quiet", "--depth=1", `file://${input.root}`, root]);
    expect(
      execFileSync("git", ["-C", root, "rev-parse", "--is-shallow-repository"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("true");
    await expect(qualifyEmergencyPatch({ ...input, root })).resolves.toMatchObject({
      delta: { commits: 1 },
    });
    await expect(
      qualifyEmergencyPatch({
        ...input,
        registryReader: async () => ({
          ok: true,
          status: 200,
          packument: { "dist-tags": { latest: "2026.11.2" } },
        }),
      }),
    ).resolves.toMatchObject({ delta: { commits: 1 } });
  });

  it("refuses binary changes even when their diff is small", async () => {
    const { input, approval, commit } = fixture();
    approval.candidateSha = commit("binary\0payload");
    input.expectedSha = approval.candidateSha;
    await expect(qualifyEmergencyPatch(input)).rejects.toThrow("binary");
  });
});

type Workflow = {
  jobs: Record<
    string,
    { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }
  >;
};
it("the real npm admission step requires an approved parent and rejects mixed evidence", () => {
  const workflow = parse(
    readFileSync(".github/workflows/openclaw-npm-release.yml", "utf8"),
  ) as Workflow;
  const step = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((entry) => entry.name === "Require preflight artifact promotion on real publish");
  expect(step?.run).toBeTruthy();
  const run = (extra: Record<string, string>) =>
    spawnSync("bash", ["-c", step!.run!], {
      encoding: "utf8",
      env: {
        ...process.env,
        RELEASE_EVIDENCE_MODE: "emergency-patch-v1",
        RELEASE_TAG: "v2026.11.2",
        RELEASE_NPM_DIST_TAG: "latest",
        PREFLIGHT_RUN_ID: "1",
        RELEASE_PUBLISH_RUN_ID: "2",
        RELEASE_PUBLISH_RUN_ATTEMPT: "1",
        GITHUB_ACTOR: "github-actions[bot]",
        FULL_RELEASE_VALIDATION_RUN_ID: "",
        FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "",
        FOCUSED_RELEASE_EVIDENCE_RUN_ID: "",
        FOCUSED_RELEASE_EVIDENCE_RUN_ATTEMPT: "",
        ...extra,
      },
    });
  expect(run({}).status).toBe(0);
  expect(run({ RELEASE_PUBLISH_RUN_ID: "" }).status).not.toBe(0);
  expect(run({ FULL_RELEASE_VALIDATION_RUN_ID: "3" }).status).not.toBe(0);
});
