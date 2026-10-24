import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = Partial<Record<"id" | "if" | "name" | "run", string>> &
  Partial<Record<"env" | "with", Record<string, string>>>;
type WorkflowJob = Partial<Record<"outputs" | "permissions" | "with", Record<string, string>>> & {
  steps?: WorkflowStep[];
};

function readWorkflow(file: string) {
  return parse(readFileSync(`.github/workflows/${file}.yml`, "utf8")) as {
    jobs?: Record<string, WorkflowJob>;
  };
}
function workflowJob(name: string): WorkflowJob {
  return expectDefined(
    readWorkflow("mantis-web-ui-chat-proof").jobs?.[name],
    `Missing ${name} job`,
  );
}
function containsAll(actual: string | undefined, expected: string[]) {
  for (const text of expected) {
    expect(actual).toContain(text);
  }
}

async function resolveCandidateRef(body: string, pullRequestHead: string) {
  const request = expectDefined(
    workflowJob("resolve_request").with,
    "Missing shared resolver inputs",
  );
  const outputs = new Map<string, string>();
  const script = expectDefined(
    readWorkflow("mantis-resolve-request").jobs?.resolve?.steps?.find(
      (step) => step.name === "Resolve refs and target PR",
    )?.with?.script,
    "Missing shared Resolve refs and target PR script",
  );
  await runInNewContext(`(async () => {\n${script}\n})()`, {
    context: {
      eventName: "issue_comment",
      repo: { owner: "openclaw", repo: "openclaw" },
      payload: { issue: { number: 123, pull_request: {} }, comment: { body } },
    },
    process: {
      env: {
        DISPATCH_PARAMS: "{}",
        EXCLUDE_PATTERN: "",
        REQUEST_PATTERN: request["request-pattern"],
        SKIP_NOTICE: request["skip-notice"],
      },
    },
    github: {
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: pullRequestHead }, base: { sha: "base" } } }),
        },
      },
    },
    core: {
      setOutput: (name: string, value: string) => outputs.set(name, value),
      info: () => {},
      notice: () => {},
      setFailed: (message: string) => {
        throw new Error(message);
      },
    },
  });
  expect(outputs.get("should_run")).toBe("true");
  return outputs.get("candidate_ref");
}

describe("Mantis Web UI chat proof workflow", () => {
  it("keeps candidate execution read-only and installs dependencies only in the candidate", () => {
    const job = workflowJob("run_web_ui_chat");
    const setup = job.steps?.find((step) => step.name === "Setup Node environment");

    expect(job.permissions).toEqual({ contents: "read" });
    expect(setup?.with).toMatchObject({
      "install-bun": "false",
      "install-deps": "false",
    });
  });

  it("publishes evidence with plain Node and no dependency setup", () => {
    const job = workflowJob("publish_evidence");
    const publish = job.steps?.find((step) => step.name === "Comment PR with inline QA evidence");

    expect(job.steps?.some((step) => step.name === "Setup Node environment")).toBe(false);
    expect(publish?.run).toContain("node scripts/mantis/publish-pr-evidence.mjs");
    expect(publish?.run).not.toContain("--import tsx");
  });

  it("retains one invocation root through capture, failure reporting, and artifact upload", () => {
    const job = workflowJob("run_web_ui_chat");
    const allocate = job.steps?.find((step) => step.id === "prepare_evidence");
    const capture = job.steps?.find((step) => step.id === "run_mantis");
    const report = job.steps?.find((step) => step.id === "build_evidence");
    const upload = job.steps?.find((step) => step.name === "Upload Mantis web UI chat artifacts");
    const rootOutput = "${{ steps.prepare_evidence.outputs.output_dir }}";

    expect(allocate?.run).toContain('mktemp -d "$output_parent/run.XXXXXX"');
    containsAll(capture?.run, [
      `root="${rootOutput}"`,
      'OPENCLAW_MANTIS_WEB_UI_CHAT_OUTPUT_DIR="$root"',
      'OPENCLAW_UI_E2E_ARTIFACT_DIR="$root"',
      // Older candidates need the allocator imported by both overlaid harness files.
      '"${GITHUB_WORKSPACE}/ui/src/test-helpers/control-ui-e2e-artifacts.ts"',
      '"$candidate_repo/ui/src/test-helpers/control-ui-e2e-artifacts.ts"',
    ]);
    expect(report?.if).toContain("always()");
    containsAll(report?.run, [`root="${rootOutput}"`, '--output-dir "$root"']);
    expect(report?.env?.PROOF_STATUS).toBe(
      "${{ steps.run_mantis.outcome == 'success' && 'pass' || 'fail' }}",
    );
    expect(upload?.if).toContain("always()");
    expect(upload?.with?.path).toBe(rootOutput);
    expect(job.outputs?.output_dir).toBe(rootOutput);
    expect(upload?.with?.name).toBe(job.outputs?.artifact_name);
  });

  it("only treats explicit candidate assignments as PR head overrides", async () => {
    const pullRequestHead = "f00ba4";
    for (const [request, expected] of [
      [
        "verify this PR head produces a redacted Control UI chat transcript artifact",
        pullRequestHead,
      ],
      ["verify candidate=e63393c publishes evidence", "e63393c"],
      ["verify head: e63393c publishes evidence", "e63393c"],
      ["HEAD: e63393c", "e63393c"],
      ["verify candidate=`e63393c` publishes evidence", "e63393c"],
      ["verify this PR head produces evidence", pullRequestHead],
      ["candidate: head", pullRequestHead],
      ["candidate=pr", pullRequestHead],
      ["head: pr-head", pullRequestHead],
      ["candidate=Pr-HeAd", pullRequestHead],
    ] as const) {
      const body = `@openclaw-mantis web ui chat proof: ${request}`;
      await expect(resolveCandidateRef(body, pullRequestHead)).resolves.toBe(expected);
    }
  });
});
