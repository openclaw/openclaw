import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  readPerformanceWorkflow,
  runPerformanceShell as runShell,
} from "./openclaw-performance-workflow.test-support.js";

const workflow = readPerformanceWorkflow();
const job = workflow.jobs.gateway_concurrency!;
const step = (name: string, owner = job) => {
  const found = owner.steps.find((item) => item.name === name);
  return expectDefined(found, name);
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const posixIt = it.skipIf(process.platform === "win32");

it("exposes credentials only to the trust-gated live step", () => {
  const live = step("Run live Gateway concurrency");
  expect(live.if).toBe(
    "${{ inputs.live_openai_candidate == true && needs.resolve_target.outputs.secret_eligible == 'true' }}",
  );
  for (const scope of [job.env, ...job.steps.filter((candidate) => candidate !== live)]) {
    expect(JSON.stringify(scope)).not.toContain("secrets.");
  }
  expect(step("Checkout Gateway concurrency helpers").with?.ref).toBe("${{ github.workflow_sha }}");
});

posixIt.each([
  { requested: "false", eligible: "false", status: 0 },
  { requested: "true", eligible: "false", status: 1 },
  { requested: "true", eligible: "true", status: 0 },
])("admits requested=$requested eligible=$eligible without secrets", (fixture) => {
  const result = runShell(step("Admit Gateway concurrency request").run!, {
    CONCURRENCY_OUTPUT: tempDirs.make("gateway-concurrency-admission-"),
    LIVE_REQUESTED: fixture.requested,
    SECRET_ELIGIBLE: fixture.eligible,
  });
  expect(result.status, result.stderr).toBe(fixture.status);
  if (fixture.status !== 0) {
    expect(result.stdout).toContain("requires the main workflow and its exact trusted target SHA");
  }
});

posixIt("resolves the immutable workload without requiring a Kova fixture schema", () => {
  const root = tempDirs.make("gateway-concurrency-resolution-");
  const output = join(root, "output");
  const sha = "a".repeat(40);
  const resolver = step("Resolve OpenClaw target ref", workflow.jobs.resolve_target);
  const result = runShell(
    'python3() { printf "%s\\n" "$FIXTURE_SHA"; }\nnode() { return 91; }\n' + resolver.run,
    {
      FIXTURE_SHA: sha,
      CI_GIT_OWNER: "fixture-git-owner",
      TARGET_CHECKOUT_DIR: root,
      TARGET_REF_INPUT: sha,
      GITHUB_REF_NAME: "main",
      GITHUB_OUTPUT: output,
      PERFORMANCE_MODE: "gateway-concurrency",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(output, "utf8")).toBe(
    `checkout_ref=${sha}\ntested_ref=${sha}\ntested_sha=${sha}\n`,
  );
});

posixIt.each([
  { provider: "mock", key: "", childStatus: "0", status: 0 },
  { provider: "openai", key: "fixture-key", childStatus: "0", status: 0 },
  { provider: "openai", key: "", childStatus: "0", status: 1 },
  { provider: "mock", key: "", childStatus: "7", status: 7 },
])("runs $provider with child=$childStatus and required auth=$key", (fixture) => {
  const root = tempDirs.make("gateway-concurrency-command-");
  const output = join(root, "output");
  mkdirSync(output);
  const argsPath = join(root, "args");
  const flavor = fixture.provider === "mock" ? "mock" : "live";
  const selected = step(`Run ${flavor} Gateway concurrency`);
  // Replace only the process boundary; execute the actual workflow's auth and pipefail logic.
  const result = runShell(
    'node() { printf "%s\\n" "$@" > "$ARGS_PATH"; return "$CHILD_STATUS"; }\n' + selected.run,
    {
      ARGS_PATH: argsPath,
      CHILD_STATUS: fixture.childStatus,
      CONCURRENCY_OUTPUT: output,
      PERFORMANCE_HELPER_DIR: join(root, "trusted helpers"),
      BENCH_PROVIDER: fixture.provider,
      OPENAI_API_KEY: fixture.key,
    },
  );
  expect(result.status, result.stderr).toBe(fixture.status);
  if (fixture.provider === "openai" && !fixture.key) {
    expect(existsSync(argsPath)).toBe(false);
    expect(result.stdout).toContain("requested live Gateway evidence cannot run");
    return;
  }
  const args = readFileSync(argsPath, "utf8").trim().split("\n");
  expect(args[2]).toBe(join(root, "trusted helpers", "scripts/bench-gateway-concurrency.ts"));
  expect(args[args.indexOf("--provider") + 1]).toBe(fixture.provider);
  expect(args[args.indexOf("--output") + 1]).toBe(join(output, `${fixture.provider}.json`));
  expect(result.stdout).not.toContain("fixture-key");
});
