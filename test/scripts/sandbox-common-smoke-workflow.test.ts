// Sandbox Common Smoke Workflow tests cover sandbox common smoke workflow script behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateWorkflowRunner, readWorkflow } from "./ci-workflow.test-support.js";

const WORKFLOW_PATH = ".github/workflows/sandbox-common-smoke.yml";

describe("sandbox common smoke workflow", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");

  it("routes Boat to hosted while preserving other backend and fork routes", () => {
    const selector = readWorkflow(WORKFLOW_PATH).jobs["sandbox-common-smoke"]["runs-on"];
    for (const runnerBackend of ["", "blacksmith", "github", "hybrid", "runson", "boat"] as const) {
      for (const eventName of ["push", "schedule", "workflow_dispatch", "pull_request"] as const) {
        expect(
          evaluateWorkflowRunner(selector, {
            eventName,
            runnerBackend,
            headRepository: "openclaw/openclaw",
          }),
        ).toBe(
          runnerBackend === "boat" || runnerBackend === "github"
            ? "ubuntu-24.04"
            : "blacksmith-4vcpu-ubuntu-2404",
        );
      }
      expect(
        evaluateWorkflowRunner(selector, {
          eventName: "pull_request",
          runnerBackend,
          headRepository: "contributor/openclaw",
        }),
      ).toBe("ubuntu-24.04");
    }
  });

  it("bounds Docker build and run smoke steps", () => {
    expect(workflow).toContain(
      "timeout --kill-after=30s 5m docker build -t openclaw-sandbox-smoke-base:trixie-slim -",
    );
    expect(workflow).toContain(
      "timeout --kill-after=30s 2m docker run --rm openclaw-sandbox-common-smoke:trixie-slim",
    );
    expect(workflow).toContain("node --version");
    expect(workflow).toContain("pnpm --version");
    expect(workflow).not.toContain("INSTALL_PNPM=0");
    expect(workflow).not.toMatch(/(^|\n)\s+docker build -t openclaw-sandbox-smoke-base/u);
    expect(workflow).not.toContain(
      'u="$(docker run --rm openclaw-sandbox-common-smoke:trixie-slim',
    );
  });
});
