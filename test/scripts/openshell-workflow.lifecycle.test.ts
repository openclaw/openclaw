import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import { parse } from "yaml";
import { createCommandTest } from "../helpers/command-fixture.js";

const test = createCommandTest();
const workflowPath = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const fixturePath = fileURLToPath(
  new URL("./fixtures/openshell-workflow-lifecycle.py", import.meta.url),
);
const namespace = "openshell-e2e-123-2";

type LifecycleReport = {
  shellStatus: number;
  calls: { command: string; args: string[] }[];
  terminated: string[];
  emergency: string[];
  reapedDescendants: number;
  fixtureRoot: string;
  containers: string[];
  networks: string[];
};

test.skipIf(process.platform !== "linux").for([
  { scenario: "success", exit: 0, retained: false, descendant: false, suite: true },
  { scenario: "leader-failure", exit: 42, retained: false, descendant: true, suite: false },
  { scenario: "cancel", exit: 143, retained: false, descendant: false, suite: true },
  { scenario: "docker-query-failure", exit: 1, retained: true, descendant: false, suite: true },
  { scenario: "docker-mutation-failure", exit: 42, retained: true, descendant: true, suite: false },
])(
  "settles the OpenShell workflow's owned resources on $scenario",
  async (scenario, { command }) => {
    const steps = parse(readFileSync(workflowPath, "utf8")).jobs.validate_special_e2e
      .steps as Array<{
      name?: string;
      run?: string;
    }>;
    const run = expectDefined(
      steps.find((step) => step.name === "Run ${{ matrix.label }}")?.run,
      "OpenShell workflow run step",
    );
    const root = command.createTempDir("openclaw-openshell-lifecycle-");
    const script = join(root, "run.sh");
    writeFileSync(script, run.replaceAll("${{ matrix.command }}", "fixture-suite"));
    const result = await command.run(
      "python3",
      ["-I", "-S", fixturePath, root, script, scenario.scenario],
      { env: { PATH: process.env.PATH }, maxBuffer: 64 * 1024 },
    );

    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(
      readFileSync(join(root, "lifecycle.json"), "utf8"),
    ) as LifecycleReport;
    expect(report.shellStatus, result.stderr).toBe(scenario.exit);
    expect(report.emergency).toEqual([]);
    expect(report.terminated).toContain("gateway");
    expect(
      report.calls.filter((call) => call.command === "openshell" && call.args.at(-1) === "whoami"),
    ).toHaveLength(1);
    expect(report.calls.some((call) => call.command === "fixture-suite")).toBe(scenario.suite);
    if (scenario.descendant) {
      expect(report.terminated).toContain("descendant");
      expect(report.reapedDescendants).toBe(1);
      expect(report.calls.some((call) => call.args.slice(-2).join(" ") === "sandbox list")).toBe(
        false,
      );
    }
    if (scenario.scenario === "cancel") {
      expect(report.terminated).toContain("suite");
    }
    expect(existsSync(report.fixtureRoot)).toBe(scenario.retained);
    expect(report.containers).toEqual(
      scenario.scenario === "docker-query-failure"
        ? ["aa11", "bb22", "cc33", "dd44", "ee55", "ff66"]
        : ["cc33", "dd44", "ff66"],
    );
    expect(report.networks).toEqual(
      scenario.retained
        ? ["another-network", namespace, `${namespace}-other`]
        : ["another-network", `${namespace}-other`],
    );
    if (scenario.scenario === "docker-query-failure") {
      expect(
        report.calls.filter((call) => call.command === "docker").map((call) => call.args[0]),
      ).toEqual(["ps"]);
    }
  },
);
