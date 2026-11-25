import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { resolveWorkflowBash } from "../helpers/workflow-bash.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
describe.skipIf(process.platform === "win32")("stable closeout GitHub backoff", () => {
  const workflow = parse(
    readFileSync(".github/workflows/openclaw-stable-main-closeout.yml", "utf8"),
  );
  const installers = ["resolve", "verify"].map((job) =>
    workflow.jobs[job].steps.find(
      (step: { name: string }) => step.name === "Install GitHub API backoff helper",
    ),
  );
  const helper: string = installers[0].run.split("<<'BASH'\n")[1]?.split("\nBASH")[0];
  let bash: string;
  beforeAll(() => {
    bash = resolveWorkflowBash();
  });

  it.each([
    {
      name: "nonretryable failure",
      response: "printf 'HTTP 403: forbidden\\n' >&2; return 42",
      status: 42,
      output: "",
      error: "HTTP 403: forbidden",
      attempts: 1,
      sleeps: [],
    },
    {
      name: "retry exhaustion",
      response: 'printf \'HTTP 429: throttled on call %s\\n\' "$call" >&2; return "$((40 + call))"',
      status: 45,
      output: "",
      error: "HTTP 429: throttled on call 5",
      attempts: 5,
      sleeps: [5, 20, 45, 80, 125],
    },
    {
      name: "case-insensitive recovery",
      response:
        "if ((call < 3)); then printf 'RaTe LiMiT exceeded\\n' >&2; return 41; fi; printf 'recovered\\n'",
      status: 0,
      output: "recovered\n",
      error: "",
      attempts: 3,
      sleeps: [5, 20],
    },
    {
      name: "nonretryable failure after throttling",
      response:
        "if ((call == 1)); then printf 'rate limit exceeded\\n' >&2; return 41; fi; printf 'HTTP 403: forbidden\\n' >&2; return 42",
      status: 42,
      output: "",
      error: "HTTP 403: forbidden",
      attempts: 2,
      sleeps: [5],
    },
  ])("preserves command status and arguments through $name", (scenario) => {
    expect(installers[1]).toEqual(installers[0]);
    expect(helper).toContain("gh_with_retry()");
    const root = tempDirs.make("closeout-backoff-");
    const read = (name: string) => readFileSync(path.join(root, name), "utf8");
    writeFileSync(path.join(root, "attempt"), "0\n");
    writeFileSync(path.join(root, "sleeps"), "");
    const args = [
      "release",
      "upload",
      "v2026.9.6",
      "asset with spaces#label",
      "--repo",
      "fixture/repo",
    ];
    const script = [
      "set -euo pipefail",
      helper,
      "gh() {",
      "  local call",
      '  read -r call < "$RUNNER_TEMP/attempt"',
      "  call=$((call + 1))",
      '  printf \'%s\\n\' "$call" > "$RUNNER_TEMP/attempt"',
      '  printf \'%s\\n\' "$@" > "$RUNNER_TEMP/args-$call"',
      scenario.response,
      "}",
      'sleep() { printf \'%s\\n\' "$1" >> "$RUNNER_TEMP/sleeps"; }',
      'if gh_with_retry "$@"; then exit 0; else exit "$?"; fi',
    ].join("\n");
    const result = spawnSync(
      bash,
      ["--noprofile", "--norc", "-c", script, "closeout-backoff", ...args],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { PATH: "", RUNNER_TEMP: root },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: scenario.status, stdout: scenario.output });
    const lines = result.stderr.split("\n").filter(Boolean);
    expect(lines.filter((line) => line.startsWith("::warning::"))).toHaveLength(
      scenario.sleeps.length,
    );
    expect(lines.filter((line) => !line.startsWith("::warning::")).join("\n")).toBe(scenario.error);
    expect(read("attempt")).toBe(String(scenario.attempts) + "\n");
    expect(read("sleeps")).toBe(scenario.sleeps.map((seconds) => String(seconds) + "\n").join(""));
    for (let call = 1; call <= scenario.attempts; call++) {
      expect(read("args-" + call)).toBe([...args, ""].join("\n"));
    }
  });

  it.each([0, 1, 2])("stops the actual evidence step on failed upload %s", (failedUpload) => {
    const root = tempDirs.make("closeout-upload-");
    writeFileSync(path.join(root, "github-api-backoff.sh"), helper);
    writeFileSync(path.join(root, "stable-main-closeout.json"), "closeout bytes\n");
    writeFileSync(path.join(root, "stable-main-closeout.json.sha256"), "checksum bytes\n");
    writeFileSync(path.join(root, "uploads"), "0\n");
    const attach = workflow.jobs.verify.steps.find(
      (step: { name: string }) => step.name === "Attach immutable closeout evidence",
    ).run;
    const script = [
      "gh() {",
      "  if [[ \"$2\" == download ]]; then printf 'HTTP 404: absent\\n' >&2; return 44; fi",
      "  [[ \"$1 $2\" == 'release upload' ]] || return 99",
      "  local call",
      '  read -r call < "$CLOSEOUT_DIR/uploads"',
      "  call=$((call + 1))",
      '  printf \'%s\\n\' "$call" > "$CLOSEOUT_DIR/uploads"',
      '  printf \'%s\\n\' "$@" > "$CLOSEOUT_DIR/upload-$call"',
      '  if [[ "$call" == "$FAILED_UPLOAD" ]]; then printf \'HTTP 403: upload refused\\n\' >&2; return 42; fi',
      "}",
      attach,
      "printf 'publication continued\\n'",
    ].join("\n");
    const result = spawnSync(bash, ["--noprofile", "--norc", "-c", script], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: "/usr/bin:/bin",
        RUNNER_TEMP: root,
        CLOSEOUT_DIR: root,
        RELEASE_TAG: "v2026.9.6",
        GITHUB_REPOSITORY: "fixture/repo",
        FAILED_UPLOAD: String(failedUpload),
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(failedUpload ? 42 : 0);
    expect(result.stdout.includes("publication continued")).toBe(!failedUpload);
    expect(readFileSync(path.join(root, "uploads"), "utf8")).toBe(String(failedUpload || 2) + "\n");
    for (let call = 1; call <= (failedUpload || 2); call++) {
      const asset = "openclaw-2026.9.6-stable-main-closeout.json" + (call === 2 ? ".sha256" : "");
      expect(readFileSync(path.join(root, "upload-" + call), "utf8").split("\n")).toEqual([
        "release",
        "upload",
        "v2026.9.6",
        path.join(root, "existing-" + asset, asset + "#" + asset),
        "--repo",
        "fixture/repo",
        "",
      ]);
    }
  });
});
