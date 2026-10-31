import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = { id?: string; name?: string; run?: string; with?: Record<string, string> };
type WorkflowJob = Partial<Record<"permissions" | "with", Record<string, string>>> & {
  steps?: WorkflowStep[];
};

function readWorkflow(file: string) {
  return parse(readFileSync(`.github/workflows/${file}.yml`, "utf8")) as {
    jobs: Record<string, WorkflowJob>;
  };
}
const jobs = readWorkflow("mantis-web-ui-chat-proof").jobs;
const script = readWorkflow("mantis-resolve-request").jobs.resolve!.steps!.find(
  (step) => step.name === "Resolve refs and target PR",
)!.with!.script!;

async function resolveCandidateRef(body: string, pullRequestHead: string) {
  const request = jobs.resolve_request!.with!;
  const outputs = new Map<string, string>();
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
  it("keeps candidate execution read-only", () =>
    expect(jobs.run_web_ui_chat!.permissions).toEqual({ contents: "read" }));

  it("overlays the capture allocator for older candidates", () => {
    const capture = jobs.run_web_ui_chat!.steps?.find((step) => step.id === "run_mantis");
    for (const owner of ["${GITHUB_WORKSPACE}", "$candidate_repo"]) {
      expect(capture?.run).toContain(`"${owner}/ui/src/test-helpers/control-ui-e2e-artifacts.ts"`);
    }
  });

  it("only treats explicit candidate assignments as PR head overrides", async () => {
    const pullRequestHead = "f00ba4";
    for (const [request, expected] of [
      ["verify this PR head produces evidence", pullRequestHead],
      ["verify candidate=e63393c publishes evidence", "e63393c"],
      ["verify head: e63393c publishes evidence", "e63393c"],
      ["verify candidate=`e63393c` publishes evidence", "e63393c"],
      ["candidate=Pr-HeAd", pullRequestHead],
    ] as const) {
      const body = `@openclaw-mantis web ui chat proof: ${request}`;
      await expect(resolveCandidateRef(body, pullRequestHead)).resolves.toBe(expected);
    }
  });
});
