import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Step = {
  name: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = { if?: string; env?: Record<string, string>; steps: Step[] };
const workflow = parse(readFileSync(".github/workflows/openclaw-performance.yml", "utf8")) as {
  jobs: Record<string, Job>;
};
const job = workflow.jobs.gateway_concurrency!;
const step = (name: string) => {
  const value = job.steps.find((candidate) => candidate.name === name);
  if (!value) {
    throw new Error(`Missing Gateway concurrency step: ${name}`);
  }
  return value;
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const posixIt = it.skipIf(process.platform === "win32");

describe("Gateway concurrency workflow", () => {
  it("keeps manual mock/live load isolated from scheduled Kova and report publication", () => {
    expect(job.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.mode == 'gateway-concurrency' }}",
    );
    for (const name of ["kova", "source_performance", "publish", "artifact_only_guard"]) {
      expect(workflow.jobs[name]?.if).toContain("inputs.mode != 'gateway-concurrency'");
    }
    const mock = step("Run mock Gateway concurrency");
    const live = step("Run live Gateway concurrency");
    expect(live.if).toBe(
      "${{ inputs.live_openai_candidate == true && needs.resolve_target.outputs.secret_eligible == 'true' }}",
    );
    expect(live.env).toEqual({
      BENCH_PROVIDER: "openai",
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
    });
    expect(mock.env).toEqual({ BENCH_PROVIDER: "mock" });
    expect(JSON.stringify(job.env)).not.toContain("secrets.");
    for (const nonLiveStep of job.steps.filter((candidate) => candidate !== live)) {
      expect(JSON.stringify(nonLiveStep)).not.toContain("secrets.");
    }
    expect(job.steps.indexOf(mock)).toBeLessThan(job.steps.indexOf(live));
    expect(job.steps.filter((candidate) => candidate.run?.includes("pnpm build"))).toHaveLength(1);
    expect(step("Checkout Gateway concurrency target").with?.ref).toBe(
      "${{ needs.resolve_target.outputs.checkout_ref }}",
    );
    expect(step("Checkout Gateway concurrency helpers").with?.ref).toBe(
      "${{ github.workflow_sha }}",
    );
    expect(step("Set up Gateway concurrency environment").with?.["cache-mode"]).toBe(
      "${{ needs.resolve_target.outputs.cache_write_allowed == 'true' && 'restore' || 'off' }}",
    );
    expect(step("Upload Gateway concurrency artifacts").if).toBe("${{ always() }}");
    expect(step("Upload Gateway concurrency artifacts").with?.["if-no-files-found"]).toBe("error");
    expect(step("Record Gateway concurrency outcome").if).toBe("${{ always() }}");
  });

  posixIt.each([
    { requested: "false", eligible: "false", status: 0 },
    { requested: "true", eligible: "false", status: 1 },
    { requested: "true", eligible: "true", status: 0 },
  ])("admits requested=$requested eligible=$eligible without secrets", (fixture) => {
    const root = tempDirs.make("gateway-concurrency-admission-");
    const result = spawnSync("bash", ["-c", step("Admit Gateway concurrency request").run!], {
      encoding: "utf8",
      env: {
        ...process.env,
        CONCURRENCY_OUTPUT: root,
        LIVE_REQUESTED: fixture.requested,
        SECRET_ELIGIBLE: fixture.eligible,
      },
    });
    expect(result.status, result.stderr).toBe(fixture.status);
    if (fixture.status !== 0) {
      expect(result.stdout).toContain(
        "requires the main workflow and its exact trusted target SHA",
      );
    }
  });

  posixIt("resolves the immutable workload without requiring a Kova fixture schema", () => {
    const root = tempDirs.make("gateway-concurrency-resolution-");
    const output = join(root, "output");
    const sha = "a".repeat(40);
    const resolver = workflow.jobs.resolve_target!.steps.find(
      (candidate) => candidate.name === "Resolve OpenClaw target ref",
    )!;
    const result = spawnSync(
      "bash",
      [
        "-c",
        'python3() { printf "%s\\n" "$FIXTURE_SHA"; }\nnode() { return 91; }\n' + resolver.run,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FIXTURE_SHA: sha,
          CI_GIT_OWNER: "fixture-git-owner",
          TARGET_CHECKOUT_DIR: root,
          TARGET_REF_INPUT: sha,
          GITHUB_REF_NAME: "main",
          GITHUB_OUTPUT: output,
          PERFORMANCE_MODE: "gateway-concurrency",
        },
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
    const selected = step(
      fixture.provider === "mock" ? "Run mock Gateway concurrency" : "Run live Gateway concurrency",
    );
    // Replace only the process boundary; execute the actual workflow's auth and pipefail logic.
    const result = spawnSync(
      "bash",
      [
        "-c",
        'node() { printf "%s\\n" "$@" > "$ARGS_PATH"; return "$CHILD_STATUS"; }\n' + selected.run,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ARGS_PATH: argsPath,
          CHILD_STATUS: fixture.childStatus,
          CONCURRENCY_OUTPUT: output,
          PERFORMANCE_HELPER_DIR: join(root, "trusted helpers"),
          BENCH_PROVIDER: fixture.provider,
          OPENAI_API_KEY: fixture.key,
        },
      },
    );
    expect(result.status, result.stderr).toBe(fixture.status);
    if (fixture.provider === "openai" && !fixture.key) {
      expect(existsSync(argsPath)).toBe(false);
      expect(result.stdout).toContain("requested live Gateway evidence cannot run");
      return;
    }
    const args = readFileSync(argsPath, "utf8").trim().split("\n");
    expect(args).toEqual([
      "--import",
      "tsx",
      join(root, "trusted helpers", "scripts/bench-gateway-concurrency.ts"),
      "--provider",
      fixture.provider,
      "--entry",
      "dist/entry.js",
      "--runs",
      "1",
      "--warmup",
      "0",
      "--agent-warmup-turns",
      "0",
      "--session-count",
      "1000",
      "--agent-count",
      "32",
      "--concurrency",
      "32",
      "--turns-per-session",
      "3",
      "--history-messages",
      "20",
      "--history-message-chars",
      "1024",
      "--probe-rounds",
      "64",
      "--cadence-ms",
      "100",
      "--session-updates",
      "100",
      "--session-update-clients",
      "2",
      "--history-clients",
      "2",
      "--history-burst",
      "2",
      "--subscribers",
      "4",
      "--control-plane",
      "--timeout-ms",
      "120000",
      "--load-cpu-prof-dir",
      join(output, `${fixture.provider}-profiles`),
      "--output",
      join(output, `${fixture.provider}.json`),
    ]);
    expect(result.stdout).not.toContain("fixture-key");
  });
});
