import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const child = parse(
  readFileSync(".github/workflows/stable-release-source-compatibility.yml", "utf8"),
);
const parent = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));

describe("stable client compatibility release wiring", () => {
  it.each(["ios", "android"])(
    "admits independent candidate and qualification roots for stable %s clients",
    (platform) => {
      const native = parse(readFileSync(`.github/workflows/${platform}-release-e2e.yml`, "utf8"));
      const steps = native.jobs.qualify.steps;
      const admission = steps[0].run.slice(steps[0].run.indexOf('if [[ -n "$CLIENT_SHA"'));
      for (const client of ["", "c".repeat(40)]) {
        const result = spawnSync("bash", ["-eu", "-c", admission], {
          env: {
            ...process.env,
            CLIENT_SHA: client,
            CLIENT_RELEASE_TAG: client ? "v2026.11.5" : "",
            TARGET_SHA: "a".repeat(40),
            GITHUB_SHA: "b".repeat(40),
          },
        });
        expect(result.status).toBe(client ? 0 : 1);
      }
      expect(
        steps.find(
          (step: { name?: string }) => step.name === "Checkout independent candidate Gateway",
        ).with.ref,
      ).toBe("${{ inputs.target_sha }}");
      const nativeRun = steps.find((step: { name?: string }) =>
        step.name?.startsWith("Qualify "),
      ).run;
      expect(nativeRun).toContain('--harness-sha "$GITHUB_SHA"');
      expect(nativeRun).toContain(
        '--candidate-root "$GITHUB_WORKSPACE/.openclaw/tmp/candidate-gateway"',
      );
    },
  );

  it.each([
    "success,success,success",
    "success,skipped,success",
    "failure,success,success",
    "success,success,cancelled",
    "success,success",
  ])("requires three successful predecessors: %s", (results) => {
    expect(child.jobs.verify.needs).toEqual(["select", "ios", "android"]);
    expect(child.jobs.verify.if).toBe("always()");
    const result = spawnSync("bash", ["-eu", "-c", child.jobs.verify.steps[0].run], {
      env: { ...process.env, RESULTS: results },
    });
    expect(result.status).toBe(results === "success,success,success" ? 0 : 1);
    expect(child.jobs.seal_release_child_evidence.needs).toEqual([
      "select",
      "ios",
      "android",
      "verify",
    ]);
    expect(child.jobs.seal_release_child_evidence.with.role).toBe("stableClientCompatibility");
  });

  it("dispatches the exact candidate using the existing independent-child owner", () => {
    const job = parent.jobs.stable_client_compatibility;
    expect(job.if).toContain('fromJSON(\'["all","ci"]\')');
    expect(job.if).not.toContain("npm-beta-v1");
    const step = job.steps.find((entry: { id?: string }) => entry.id === "dispatch");
    expect(step.env.TARGET_SHA).toBe("${{ needs.resolve_target.outputs.sha }}");
    const branch = step.run.match(/stable-client\)\n([\s\S]*?)\s+;;/)?.[1];
    expect(branch).toBeTruthy();
    const result = spawnSync(
      "bash",
      ["-eu", "-c", 'dispatch_child() { printf "%s\\n" "$@"; };\n' + branch],
      {
        env: {
          ...process.env,
          TARGET_SHA: "a".repeat(40),
          GITHUB_RUN_ID: "12",
          GITHUB_RUN_ATTEMPT: "1",
        },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "stable-release-source-compatibility.yml",
      "Stable Release Source Compatibility full-release-validation-12-1-stable-client",
      "-f",
      "target_sha=" + "a".repeat(40),
      "-f",
      "dispatch_id=full-release-validation-12-1-stable-client",
    ]);
    expect(parent.jobs.release_execution_plan.needs).toContain("stable_client_compatibility");
    const planStep = parent.jobs.release_execution_plan.steps.find(
      (entry: { id?: string }) => entry.id === "plan_inputs",
    );
    expect(planStep.env.STABLE_CLIENT_RUN_ID).toBe(
      "${{ needs.stable_client_compatibility.outputs.run_id }}",
    );
    expect(planStep.run).toContain("stableClientCompatibility: {result: $stableClientResult");
  });
});
