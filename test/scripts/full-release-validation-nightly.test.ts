import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  decodePublicationDispatchEnvelope,
  publicationDispatchEnvelope,
} from "../../scripts/full-release-publication-contract.mjs";
import { evaluateWorkflowExpression, readWorkflow } from "./ci-workflow.test-support.js";

const nightly = readWorkflow(".github/workflows/full-release-validation-nightly.yml");
const frv = readWorkflow(".github/workflows/full-release-validation.yml");
const sha = "a".repeat(40);
const envelope =
  '{"publicationSelection":null,"trustedWorkflow":null,"validationPurpose":"main-qualification"}';

async function runDispatcher(
  runs: { status: string; conclusion?: string; html_url?: string }[] = [],
) {
  const listWorkflowRuns = vi.fn().mockResolvedValue({ data: { workflow_runs: runs } });
  const dispatch = vi.fn().mockResolvedValue(undefined);
  const summary = {
    addHeading: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn(),
  };
  const script = nightly.jobs.dispatch.steps[0].with.script;
  await runInNewContext(`(async () => { ${script} })()`, {
    github: { rest: { actions: { listWorkflowRuns, createWorkflowDispatch: dispatch } } },
    context: { repo: { owner: "openclaw", repo: "openclaw" }, sha },
    core: { summary },
  });
  return { listWorkflowRuns, dispatch, summary };
}

describe("nightly Full Release Validation", () => {
  it("schedules one daily run and permits manual dispatch without inputs", () => {
    expect(nightly.on.schedule).toEqual([{ cron: "0 4 * * *" }]);
    expect(nightly.on).toHaveProperty("workflow_dispatch");
    expect(nightly.on.workflow_dispatch?.inputs).toBeUndefined();
  });

  it.each(["schedule", "workflow_dispatch"] as const)(
    "admits %s only on canonical main",
    (eventName) => {
      const expression = "${{ " + nightly.jobs.dispatch.if + " }}";
      const context = {
        eventName,
        repository: "openclaw/openclaw",
        ref: "refs/heads/main",
        runAttempt: 1,
      };
      expect(evaluateWorkflowExpression(expression, context)).toBe(true);
      expect(
        evaluateWorkflowExpression(expression, { ...context, repository: "fork/openclaw" }),
      ).toBe(false);
      expect(evaluateWorkflowExpression(expression, { ...context, ref: "refs/heads/topic" })).toBe(
        false,
      );
    },
  );

  it("dispatches exact-SHA main qualification using declared FRV inputs", async () => {
    const { listWorkflowRuns, dispatch, summary } = await runDispatcher();
    expect(listWorkflowRuns).toHaveBeenCalledExactlyOnceWith({
      owner: "openclaw",
      repo: "openclaw",
      workflow_id: "full-release-validation.yml",
      branch: "main",
      event: "workflow_dispatch",
      head_sha: sha,
      per_page: 30,
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      owner: "openclaw",
      repo: "openclaw",
      workflow_id: "full-release-validation.yml",
      ref: "main",
      inputs: {
        ref: "main",
        expected_sha: sha,
        trusted_workflow_json: envelope,
        release_profile: "stable",
        run_release_soak: "true",
        reuse_evidence: "true",
        rerun_group: "all",
        provider: "openai",
        mode: "both",
        fail_fast: "false",
      },
    });
    const { inputs } = dispatch.mock.lastCall![0];
    for (const [key, value] of Object.entries(inputs)) {
      const declared = frv.on.workflow_dispatch?.inputs?.[key];
      expect(declared, key).toBeDefined();
      if (declared?.type === "choice") {
        expect(declared.options, key).toContain(value);
      }
    }
    expect(decodePublicationDispatchEnvelope(inputs.trusted_workflow_json)).toEqual({
      trustedWorkflow: null,
      validationPurpose: "main-qualification",
      publicationSelection: null,
    });
    expect(
      publicationDispatchEnvelope(null, {
        validationPurpose: "main-qualification",
        publicationSelection: null,
      }),
    ).toBe(envelope);
    expect(summary.addHeading).toHaveBeenCalledWith("Nightly Full Release Validation dispatched");
    expect(summary.addRaw).toHaveBeenCalledWith(expect.stringContaining(sha));
    expect(summary.addRaw).toHaveBeenCalledWith(
      expect.stringContaining("This dispatcher succeeding is not a passing validation result."),
    );
    expect(summary.write).toHaveBeenCalledOnce();
  });

  it.each([
    { status: "queued" },
    { status: "in_progress" },
    { status: "waiting" },
    { status: "pending" },
    { status: "requested" },
  ])("skips a covered SHA for $status / $conclusion", async (run) => {
    const html_url = "https://github.com/openclaw/openclaw/actions/runs/123";
    const { dispatch, summary } = await runDispatcher([{ ...run, html_url }]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(summary.addHeading).toHaveBeenCalledWith(
      "Nightly Full Release Validation already covered",
    );
    expect(summary.addRaw).toHaveBeenCalledWith(html_url);
    expect(summary.write).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"])(
    "dispatches again after a completed %s parent",
    async (conclusion) => {
      const { dispatch } = await runDispatcher([{ status: "completed", conclusion }]);
      expect(dispatch).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "honors child evidence reuse=%s for the nightly shape",
    (reuseEvidence) => {
      const expression = frv.env.CHILD_EVIDENCE_REUSE.replace(/^\$\{\{\s*|\s*\}\}$/gu, "");
      expect(
        runInNewContext(expression, {
          inputs: { reuse_evidence: reuseEvidence, rerun_group: "all" },
          github: { ref: "refs/heads/main" },
          startsWith: (value: string, prefix: string) => value.startsWith(prefix),
        }),
      ).toBe(reuseEvidence);
    },
  );
});
