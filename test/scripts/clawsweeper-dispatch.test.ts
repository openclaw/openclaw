import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowExpression } from "./ci-workflow.test-support.js";

const workflow = parse(readFileSync(".github/workflows/clawsweeper-dispatch.yml", "utf8")) as {
  jobs: {
    dispatch: {
      concurrency: { group: string; "cancel-in-progress": string };
      steps: { name: string; run?: string }[];
    };
  };
};
const install = workflow.jobs.dispatch.steps.find(
  (step) => step.name === "Install GitHub API backoff helper",
)?.run;
const helper = install?.split("<<'BASH'\n")[1]?.split("\nBASH")[0];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const cases = [
  {
    name: "returns successful output without retrying",
    response: `printf '{"accepted":true}\\n'`,
    result: { status: 0, stdout: '{"accepted":true}\n', stderr: "" },
    attempts: 1,
    sleeps: [],
  },
  {
    name: "preserves a non-retryable failure instead of reporting success",
    response: `printf 'permission denied\\n' >&2; return 42`,
    result: { status: 42, stdout: "", stderr: "permission denied\n" },
    attempts: 1,
    sleeps: [],
  },
  {
    name: "retries case-insensitive rate limits and returns recovered output",
    response: `
      if ((call < 3)); then
        printf 'API RaTe LiMiT exceeded\\n' >&2
        return 41
      fi
      printf 'recovered\\n'`,
    result: { status: 0, stdout: "recovered\n", stderr: "" },
    attempts: 3,
    sleeps: [5, 20],
  },
  {
    name: "returns the last HTTP 429 failure after five attempts",
    response: `printf 'HTTP 429: throttled on call %s\\n' "$call" >&2; return "$((40 + call))"`,
    result: { status: 45, stdout: "", stderr: "HTTP 429: throttled on call 5\n" },
    attempts: 5,
    sleeps: [5, 20, 45, 80, 125],
  },
  {
    name: "stops immediately when a retry becomes non-retryable",
    response: `
      if ((call == 1)); then
        printf 'rate limit exceeded\\n' >&2
        return 41
      fi
      printf 'HTTP 403: forbidden\\n' >&2
      return 42`,
    result: { status: 42, stdout: "", stderr: "HTTP 403: forbidden\n" },
    attempts: 2,
    sleeps: [5],
  },
];

describe.skipIf(process.platform === "win32")("ClawSweeper GitHub API backoff", () => {
  let bash: string;

  beforeAll(() => {
    expect(helper).toContain("gh_api_with_retry()");
    const candidates =
      process.platform === "darwin"
        ? ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash"]
        : ["/bin/bash"];
    bash =
      candidates.find(
        (binary) =>
          spawnSync(binary, ["--noprofile", "--norc", "-c", "((BASH_VERSINFO[0] >= 4))"], {
            env: { PATH: process.env.PATH },
            timeout: 5_000,
          }).status === 0,
      ) ?? "";
    if (!bash) {
      throw new Error("ClawSweeper backoff tests require Bash 4+ (on macOS: brew install bash).");
    }
  });

  it.each(cases)("$name", ({ response, result: expected, attempts, sleeps }) => {
    const root = tempDirs.make("clawsweeper-backoff-");
    const read = (file: string) => readFileSync(join(root, file), "utf8");
    const args = ["synthetic/dispatches", "--method", "POST", "-f", "message=two words"];
    writeFileSync(join(root, "attempt"), "0\n");
    writeFileSync(join(root, "sleeps"), "");
    const script = `set -euo pipefail
${helper}
gh() {
  local call
  read -r call < "$RUNNER_TEMP/attempt"
  call=$((call + 1))
  printf '%s\\n' "$call" > "$RUNNER_TEMP/attempt"
  printf '%s\\n' "$@" > "$RUNNER_TEMP/args-$call"
  ${response}
}
sleep() { printf '%s\\n' "$1" >> "$RUNNER_TEMP/sleeps"; }
if gh_api_with_retry "$@"; then
  exit 0
else
  exit "$?"
fi`;
    const result = spawnSync(
      bash,
      ["--noprofile", "--norc", "-c", script, "backoff-test", ...args],
      {
        encoding: "utf8",
        timeout: 5_000,
        // No inherited credentials, startup hooks, or external commands: gh and sleep are stubs.
        env: { PATH: "", RUNNER_TEMP: root },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: expected.status, stdout: expected.stdout });
    const stderrLines = result.stderr.split("\n").filter(Boolean);
    const warnings = stderrLines.filter((line) => line.startsWith("::warning::"));
    expect(warnings).toHaveLength(sleeps.length);
    expect(stderrLines.filter((line) => !line.startsWith("::warning::")).join("\n")).toBe(
      expected.stderr.trimEnd(),
    );
    expect(read("attempt")).toBe(`${attempts}\n`);
    expect(read("sleeps")).toBe(sleeps.map((seconds) => `${seconds}\n`).join(""));
    for (let call = 1; call <= attempts; call++) {
      expect(read(`args-${call}`)).toBe(["api", ...args, ""].join("\n"));
    }
  });
});

type BurstEvent = {
  name:
    | "pull_request_target"
    | "pull_request_review"
    | "pull_request_review_comment"
    | "issue_comment";
  action: string;
  comment?: number;
};

// Replays admitted events for one PR through GitHub job concurrency: a group keeps one
// running and one pending run, a newer run replaces the pending one, and cancel-in-progress
// also stops the running one. Nothing finishes mid-burst, matching same-second webhooks.
function replayBurst(events: BurstEvent[]) {
  type Run = { cancelled: boolean };
  const concurrency = workflow.jobs.dispatch.concurrency;
  const slots = new Map<string, { running?: Run; pending?: Run }>();
  const runs = events.map((event, index) => {
    const context = {
      eventName: event.name,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runId: 38349881260 + index,
      githubEvent: {
        action: event.action,
        issue: event.name === "issue_comment" ? { number: 170628 } : {},
        pull_request: event.name === "issue_comment" ? {} : { number: 170628 },
        comment: event.comment === undefined ? {} : { id: event.comment },
      },
    };
    const group = String(evaluateWorkflowExpression(concurrency.group, context));
    const run = { cancelled: false };
    const { running, pending } = slots.get(group) ?? {};
    if (pending) {
      pending.cancelled = true;
    }
    if (running && evaluateWorkflowExpression(concurrency["cancel-in-progress"], context)) {
      running.cancelled = true;
      slots.set(group, { running: run });
    } else {
      slots.set(group, running ? { running, pending: run } : { running: run });
    }
    return run;
  });
  return runs.map((run) => run.cancelled);
}

describe("ClawSweeper dispatch concurrency", () => {
  it.each([
    {
      name: "never cancels review runs on the PR head when comments arrive (#170628)",
      events: [
        { name: "pull_request_review", action: "submitted" },
        { name: "pull_request_review_comment", action: "created", comment: 11 },
        { name: "pull_request_review_comment", action: "created", comment: 12 },
        { name: "pull_request_review_comment", action: "created", comment: 13 },
        { name: "issue_comment", action: "created", comment: 21 },
        { name: "issue_comment", action: "created", comment: 22 },
        { name: "pull_request_review", action: "edited" },
        { name: "issue_comment", action: "edited", comment: 21 },
      ] satisfies BurstEvent[],
      cancelled: [false, false, false, false, true, false, false, false],
    },
    {
      name: "supersedes pull request runs only with newer pull request runs",
      events: [
        { name: "pull_request_target", action: "opened" },
        { name: "issue_comment", action: "edited", comment: 21 },
        { name: "pull_request_review", action: "edited" },
        { name: "pull_request_target", action: "labeled" },
        { name: "pull_request_target", action: "labeled" },
        { name: "pull_request_target", action: "ready_for_review" },
      ] satisfies BurstEvent[],
      cancelled: [true, false, false, true, true, false],
    },
  ])("$name", ({ events, cancelled }) => {
    expect(replayBurst(events)).toEqual(cancelled);
  });
});
