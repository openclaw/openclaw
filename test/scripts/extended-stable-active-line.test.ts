import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateActiveExtendedStableLine } from "../../scripts/openclaw-npm-extended-stable-release.mjs";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const nodeExecutable = resolveTestNodeExecPath();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("extended-stable live publication eligibility", () => {
  it("retires the same qualified candidate when main advances, including the year boundary", () => {
    expect(() => validateActiveExtendedStableLine("2026.12.34", "2027.1.1")).not.toThrow();
    expect(() => validateActiveExtendedStableLine("2026.12.34", "2027.2.1")).toThrow(
      "only the trailing completed month",
    );
  });

  it.skipIf(process.platform === "win32").each([
    { mainVersion: "2026.8.1", expectedStatus: 42, expectedError: "" },
    {
      mainVersion: "2026.9.1",
      expectedStatus: 1,
      expectedError: "only the trailing completed month",
    },
    {
      mainVersion: "unavailable",
      expectedStatus: 1,
      expectedError: "fixture main API unavailable",
    },
  ])(
    "checks live main $mainVersion before entering the parent's mutation-capable publication phase",
    ({ mainVersion, expectedStatus, expectedError }) => {
      const root = tempDirs.make("extended-stable-dispatch-");
      const bin = join(root, "bin");
      const harness = join(root, ".release-harness/scripts");
      mkdirSync(bin);
      mkdirSync(join(harness, "lib"), { recursive: true });
      for (const script of [
        "openclaw-npm-extended-stable-release.mjs",
        "lib/release-version.mjs",
      ]) {
        writeFileSync(join(harness, script), readFileSync(join("scripts", script)));
      }
      // Keep the real sourced helper and stop at the next phase boundary. This
      // prevents all publishing while proving the active case crosses admission.
      writeFileSync(
        join(harness, "lib/release-publish-children.sh"),
        `${readFileSync("scripts/lib/release-publish-children.sh", "utf8")}\nverify_release_tag_target() { echo admitted >> "$EVENTS"; exit 42; }\n`,
      );
      const events = join(root, "events");
      writeFileSync(events, "");
      writeFileSync(join(bin, "node"), `#!/bin/sh\nexec "${nodeExecutable}" "$@"\n`, {
        mode: 0o755,
      });
      writeFileSync(
        join(bin, "gh"),
        `#!${nodeExecutable}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.EVENTS, JSON.stringify(args) + "\\n");
if (JSON.stringify(args) !== JSON.stringify(["api", "repos/openclaw/openclaw/contents/package.json?ref=refs/heads/main", "--jq", ".content"])) {
  process.stderr.write("Unexpected GitHub operation");
  process.exit(90);
}
if (${JSON.stringify(mainVersion)} === "unavailable") {
  process.stderr.write("fixture main API unavailable");
  process.exit(1);
}
process.stdout.write(${JSON.stringify(Buffer.from(JSON.stringify({ version: mainVersion })).toString("base64"))});
`,
        { mode: 0o755 },
      );
      const workflow = parse(
        readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"),
      ) as { jobs: Record<string, { steps?: { name?: string; run?: string }[] }> };
      const dispatch = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .find((step) => step.name === "Dispatch publish workflows");
      expect(dispatch?.run).toBeTruthy();
      // GitHub resolves expressions before passing the run body to bash.
      const run = dispatch!.run!.replaceAll(/\$\{\{[^}]*\}\}/gu, "fixture");
      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", run], {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          EVENTS: events,
          GITHUB_WORKSPACE: root,
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_REF: "refs/tags/release-publish/bbbbbbbbbbbb-123",
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          PARENT_WORKFLOW_SHA: "b".repeat(40),
          CHILD_WORKFLOW_REF: "release-publish/bbbbbbbbbbbb-123",
          RELEASE_TAG: "v2026.7.34",
          TARGET_SHA: "a".repeat(40),
          RELEASE_NPM_DIST_TAG: "extended-stable",
          PUBLISH_OPENCLAW_NPM: "true",
          WAIT_FOR_CLAWHUB: "false",
          RUNNER_TEMP: root,
          BYPASS_EXTENDED_STABLE_GUARD: "true",
        },
      });
      expect(result.status, result.stderr).toBe(expectedStatus);
      if (expectedError) {
        expect(result.stderr).toContain(expectedError);
      }
      const calls = readFileSync(events, "utf8").trim().split("\n");
      expect(calls).toEqual([
        JSON.stringify([
          "api",
          "repos/openclaw/openclaw/contents/package.json?ref=refs/heads/main",
          "--jq",
          ".content",
        ]),
        ...(expectedStatus === 42 ? ["admitted"] : []),
      ]);
    },
  );
});
