import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
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

const cases = [
  {
    name: "returns successful output without retrying",
    response: `printf '{"accepted":true}\\n'`,
    code: 0,
    output: '{"accepted":true}\n',
    error: "",
    attempts: 1,
    sleeps: [],
  },
  {
    name: "preserves a non-retryable failure instead of reporting success",
    response: `printf 'permission denied\\n' >&2; return 42`,
    code: 42,
    output: "",
    error: "permission denied\n",
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
    code: 0,
    output: "recovered\n",
    error: "",
    attempts: 3,
    sleeps: [5, 20],
  },
  {
    name: "returns the last HTTP 429 failure after five attempts",
    response: `printf 'HTTP 429: throttled on call %s\\n' "$call" >&2; return "$((40 + call))"`,
    code: 45,
    output: "",
    error: "HTTP 429: throttled on call 5\n",
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
    code: 42,
    output: "",
    error: "HTTP 403: forbidden\n",
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
    const compatible = candidates.find(
      (binary) =>
        spawnSync(binary, ["--noprofile", "--norc", "-c", "((BASH_VERSINFO[0] >= 4))"], {
          env: { PATH: process.env.PATH },
          timeout: 5_000,
        }).status === 0,
    );
    if (!compatible) {
      throw new Error("ClawSweeper backoff tests require Bash 4+ (on macOS: brew install bash).");
    }
    bash = compatible;
  });

  it.each(cases)("$name", ({ response, code, output, error, attempts, sleeps }) => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-backoff-"));
    const args = ["synthetic/dispatches", "--method", "POST", "-f", "message=two words"];
    try {
      writeFileSync(join(root, "attempt"), "0\n");
      writeFileSync(join(root, "sleeps"), "");
      const result = spawnSync(
        bash,
        [
          "--noprofile",
          "--norc",
          "-c",
          `set -euo pipefail
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
fi`,
          "backoff-test",
          ...args,
        ],
        {
          encoding: "utf8",
          timeout: 5_000,
          // No inherited credentials, startup hooks, or external commands: gh and sleep are stubs.
          env: { PATH: "", RUNNER_TEMP: root },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(code);
      expect(result.stdout).toBe(output);
      const stderrLines = result.stderr.split("\n").filter(Boolean);
      const warnings = stderrLines.filter((line) => line.startsWith("::warning::"));
      expect(warnings).toHaveLength(sleeps.length);
      expect(stderrLines.filter((line) => !line.startsWith("::warning::")).join("\n")).toBe(
        error.trimEnd(),
      );
      expect(readFileSync(join(root, "attempt"), "utf8")).toBe(`${attempts}\n`);
      expect(readFileSync(join(root, "sleeps"), "utf8")).toBe(
        sleeps.map((seconds) => `${seconds}\n`).join(""),
      );
      for (let call = 1; call <= attempts; call++) {
        expect(readFileSync(join(root, `args-${call}`), "utf8")).toBe(
          ["api", ...args, ""].join("\n"),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
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
  return runs.map((run, index) => `${events[index]?.name}${run.cancelled ? " cancelled" : ""}`);
}

describe("ClawSweeper dispatch concurrency", () => {
  it("never cancels review runs on the PR head when comments arrive (#170628)", () => {
    expect(
      replayBurst([
        { name: "pull_request_review", action: "submitted" },
        { name: "pull_request_review_comment", action: "created", comment: 11 },
        { name: "pull_request_review_comment", action: "created", comment: 12 },
        { name: "pull_request_review_comment", action: "created", comment: 13 },
        { name: "issue_comment", action: "created", comment: 21 },
        { name: "issue_comment", action: "created", comment: 22 },
        { name: "pull_request_review", action: "edited" },
        { name: "issue_comment", action: "edited", comment: 21 },
      ]),
    ).toEqual([
      "pull_request_review",
      "pull_request_review_comment",
      "pull_request_review_comment",
      "pull_request_review_comment",
      // Superseded by its own edit; comment runs never attach to the PR head.
      "issue_comment cancelled",
      "issue_comment",
      "pull_request_review",
      "issue_comment",
    ]);
  });

  it("supersedes pull request runs only with newer pull request runs", () => {
    expect(
      replayBurst([
        { name: "pull_request_target", action: "opened" },
        { name: "issue_comment", action: "edited", comment: 21 },
        { name: "pull_request_review", action: "edited" },
        { name: "pull_request_target", action: "labeled" },
        { name: "pull_request_target", action: "labeled" },
        { name: "pull_request_target", action: "ready_for_review" },
      ]),
    ).toEqual([
      "pull_request_target cancelled",
      "issue_comment",
      "pull_request_review",
      "pull_request_target cancelled",
      "pull_request_target cancelled",
      "pull_request_target",
    ]);
  });
});
