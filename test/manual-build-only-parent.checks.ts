import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { parse } from "yaml";
import { SEALED_NPM_PREFLIGHT_SCHEMA } from "../scripts/npm-prepared-bundle.mjs";

type Step = { name: string; run: string };
const workflow = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"));
const steps = workflow.jobs.resolve_release_target.steps as Step[];
const step = (name: string) => steps.find((entry) => entry.name === name)!;

// Execute the actual parent selector, replacing only archive/network boundaries.
// Artifact authentication and archive integrity are covered by the evidence suite.
it.each([
  [SEALED_NPM_PREFLIGHT_SCHEMA, "packet", true],
  [SEALED_NPM_PREFLIGHT_SCHEMA, "", false],
  ["openclaw.qualified-npm-preflight/v1", "packet", false],
  ["unknown", "packet", false],
])("parent SDK acquisition for %s with request %s admits=%s", async (schema, request, admitted) => {
  const directory = mkdtempSync(join(tmpdir(), "build-only-parent-"));
  try {
    const producer = { id: 123, run_attempt: 1 };
    const artifact = { id: 456, name: "openclaw-npm-preflight-v2026.11.9", expired: false };
    const download = vi.fn(async () => {});
    const script = step("Download OpenClaw npm preflight manifest")
      .run.split("<<'NODE'\n")[1]!
      .split("\nNODE")[0]!
      .replace(/^import .*;\n/gmu, "");
    mkdirSync(join(directory, "full-release-validation-manifest"));
    writeFileSync(
      join(directory, "full-release-validation-manifest/full-release-validation-manifest.json"),
      "{}",
    );
    const result = runInNewContext(`(async () => { ${script} })()`, {
      process: {
        argv: [
          "node",
          "-",
          JSON.stringify(producer),
          JSON.stringify({
            descriptor: { schema },
            producer: { runAttempt: "1" },
            artifact,
          }),
        ],
        env: {
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: join(directory, "output"),
          RELEASE_TAG: "v2026.11.9",
          FAST_TRACK_REQUEST_JSON: request,
        },
      },
      execFileSync: () => JSON.stringify([{ total_count: 1, artifacts: [artifact] }]),
      appendFileSync,
      mkdirSync,
      readFileSync,
      rmSync,
      writeFileSync,
      dirname,
      join,
      SEALED_NPM_PREFLIGHT_SCHEMA,
      downloadFullReleaseNpmPreflight: download,
    });
    if (admitted) {
      await result;
      expect(download).toHaveBeenCalledOnce();
      expect(readFileSync(join(directory, "output"), "utf8")).toContain(`name=${artifact.name}`);
    } else {
      await expect(result).rejects.toThrow("exactly one plugin-sdk-api-release-diff");
      expect(download).not.toHaveBeenCalled();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  [4, false, 0],
  [4, true, 1],
  [3, false, 1],
])(
  "parent validation preserves tarball integrity without SDK evidence for version=%s corrupt=%s",
  (version, corrupt, status) => {
    const directory = mkdtempSync(join(tmpdir(), "build-only-parent-"));
    try {
      const preflight = join(directory, "openclaw-npm-preflight-manifest");
      mkdirSync(preflight);
      writeFileSync(
        join(preflight, "preflight-manifest.json"),
        JSON.stringify({
          version,
          releaseTag: "v2026.11.9",
          releaseSha: "a".repeat(40),
          tarballName: "openclaw.tgz",
          tarballSha256: createHash("sha256").update("sealed bytes").digest("hex"),
        }),
      );
      writeFileSync(join(preflight, "openclaw.tgz"), corrupt ? "corrupted" : "sealed bytes");
      // The real provenance/full-manifest owners run earlier. Stub those external
      // commands here, not the tarball checks or the parent SDK handling under test.
      const result = spawnSync(
        "bash",
        ["-c", "node() { return 0; };\n" + step("Validate OpenClaw npm preflight manifest").run],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            RUNNER_TEMP: directory,
            GITHUB_OUTPUT: join(directory, "output"),
            GITHUB_WORKSPACE: directory,
            GITHUB_REPOSITORY: "openclaw/openclaw",
            RELEASE_TAG: "v2026.11.9",
            EXPECTED_SHA: "a".repeat(40),
            PREFLIGHT_WORKFLOW_BRANCH: "main",
            PREFLIGHT_WORKFLOW_PATH: ".github/workflows/full-release-artifacts.yml",
            PREFLIGHT_WORKFLOW_SHA: "b".repeat(40),
            PREFLIGHT_RUN_ID: "123",
            PREFLIGHT_RUN_ATTEMPT: "1",
            FULL_RELEASE_VALIDATION_RUN_ID: "123",
            FULL_RELEASE_VALIDATION_RUN_ATTEMPT: "1",
            RELEASE_NPM_DIST_TAG: "latest",
            WORKFLOW_SHA: "b".repeat(40),
          },
        },
      );
      expect(result.status, result.stderr).toBe(status);
      if (version === 3) {
        expect(result.stderr).toContain("Immutable Plugin SDK API evidence artifact is missing");
      }
      if (corrupt) {
        expect(result.stderr).toContain("tarball digest mismatch");
      }
      if (status === 0) {
        expect(readFileSync(join(directory, "output"), "utf8")).toContain(`sha=${"a".repeat(40)}`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
