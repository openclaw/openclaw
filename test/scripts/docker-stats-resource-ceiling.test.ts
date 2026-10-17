import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs";
const MAX_STATS_SAMPLE_LINE_BYTES = 1024 * 1024;
const tempRoots: string[] = [];
const sample = (MemUsage = "128MiB / 2GiB", CPUPerc = "25.0%", ending = "\n") =>
  JSON.stringify({ MemUsage, CPUPerc }) + ending;

function writeStats(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-docker-stats-"));
  tempRoots.push(root);
  const file = join(root, "stats.jsonl");
  writeFileSync(file, contents);
  return file;
}

function runAssert(
  statsFile: string,
  maxMemoryMiB = "512",
  maxCpuPercent = "100",
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [SCRIPT_PATH, statsFile, maxMemoryMiB, maxCpuPercent, "test"],
    {
      encoding: "utf8",
      env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "", ...env },
    },
  );
}

function validStatsLineWithBytes(byteLength: number): string {
  const prefix = '{"MemUsage":"128MiB / 2GiB","CPUPerc":"25.0%","padding":"';
  const suffix = '"}';
  const paddingLength = byteLength - Buffer.byteLength(prefix + suffix, "utf8");
  expect(paddingLength).toBeGreaterThan(0);
  return `${prefix}${"x".repeat(paddingLength)}${suffix}`;
}

function expectRejected(
  contents: string,
  message: string,
  memory = "512",
  cpu = "100",
  env: NodeJS.ProcessEnv = {},
) {
  const result = runAssert(writeStats(contents), memory, cpu, env);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
  return result;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs", () => {
  it.each([false, true])("reports ceilings as local errors or Actions warnings: %s", (actions) => {
    const statsFile = writeStats(sample("513MiB / 2GiB", "101.0%"));
    const summary = join(dirname(statsFile), "summary.md");
    const result = runAssert(statsFile, "512", "100", {
      CI: "1",
      GITHUB_ACTIONS: actions ? "true" : "",
      GITHUB_STEP_SUMMARY: summary,
    });

    expect(result.status, result.stderr).toBe(actions ? 0 : 1);
    expect(result.stderr).toContain("memory peak 513.0MiB exceeded 512MiB");
    expect(result.stderr).toContain(
      actions ? "CPU peak 101.0%25 exceeded 100%25" : "CPU peak 101.0% exceeded 100%",
    );
    if (actions) {
      expect(result.stderr).toContain(`::warning file=${SCRIPT_PATH},line=1,col=0`);
      const report = readFileSync(summary, "utf8");
      expect(report).toContain("Docker memory budget");
      expect(report).toContain("Docker CPU budget");
      expect(report).toContain("CPU peak 101.0% exceeded 100%");
    } else {
      expect(result.stderr).not.toContain("::warning");
    }
  });

  it("rejects invalid resource limits instead of disabling the ceiling", () => {
    for (const memory of ["nope", "1e3"]) {
      expectRejected(sample(), "max memory MiB must be a finite non-negative number", memory);
    }
    expectRejected(sample(), "max CPU percent must be a finite non-negative number", "512", "1e3");
  });

  it.each(["", "true"])("rejects invalid samples in Actions mode %s", (actions) => {
    const env = { GITHUB_ACTIONS: actions };
    expectRejected("{}\n", "had invalid MemUsage", "512", "100", env);
    expectRejected(sample("bad", "bad"), "had invalid MemUsage", "512", "100", env);
    expectRejected(sample(undefined, "1e3%"), "had invalid CPUPerc", "512", "100", env);
  });

  it("parses mixed stats lines, enforces peaks, and ignores terminal samples", () => {
    const cappedLine = validStatsLineWithBytes(MAX_STATS_SAMPLE_LINE_BYTES);
    const paddedLine = validStatsLineWithBytes(1024);
    const result = runAssert(
      writeStats(
        [
          sample(),
          `${paddedLine}\n`,
          `${cappedLine}\r\n`,
          sample(undefined, undefined, "\r"),
          sample("64MiB / 2GiB", "15.0%", "\r"),
          sample("512B / 2GiB", "0.5%"),
          sample("0B / 0B", "0.0%"),
        ].join(""),
      ),
      "256.5",
      "50.5",
    );

    expect(Buffer.byteLength(cappedLine, "utf8")).toBe(MAX_STATS_SAMPLE_LINE_BYTES);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("memory=128.0MiB");
    expect(result.stdout).toContain("cpu=25.0%");
    expect(result.stdout).toContain("samples=6");
  });

  it("rejects oversized stats sample lines before parsing JSON", () => {
    const result = expectRejected(
      `{"padding":"${"x".repeat(1024 * 1024)}"}\n`,
      "exceeded 1048576 bytes",
    );
    expect(result.stderr).not.toContain("was not valid JSON");
  });

  it.each([
    ["0B / 0B", "no docker stats samples captured"],
    ["0B / 2GiB", "had non-positive MemUsage"],
  ])("rejects unusable sample %s", (memory, message) => {
    expectRejected(sample(memory, "0.0%"), message);
  });
});

describe("kitchen-sink Docker limit reporting", () => {
  it.each([0, 23])("relays container warnings and preserves exit %s", (runStatus) => {
    const root = dirname(writeStats(""));
    const scripts = join(root, "scripts");
    mkdirSync(join(scripts, "e2e"), { recursive: true });
    mkdirSync(join(scripts, "lib"));
    const runner = join(scripts, "e2e", "kitchen-sink-rpc-docker.sh");
    writeFileSync(runner, readFileSync("scripts/e2e/kitchen-sink-rpc-docker.sh", "utf8"));
    writeFileSync(
      join(scripts, "lib", "frozen-target-compat.sh"),
      `
openclaw_resolve_frozen_plugin_harness_capabilities() { return 0; }
openclaw_append_frozen_plugin_harness_docker_env() { :; }
`,
    );
    writeFileSync(
      join(scripts, "lib", "docker-e2e-image.sh"),
      `
docker_e2e_resolve_image() { printf fixture; }
docker_e2e_read_nonnegative_decimal_env() { printf '%s' "$2"; }
docker_e2e_build_or_reuse() { :; }
docker_e2e_docker_cmd() { :; }
docker_e2e_harness_mount_args() { DOCKER_E2E_HARNESS_ARGS=(--mount fixture); }
docker_e2e_docker_run_cmd() {
  printf '%s\\n' "$@" > "$FIXTURE_ARGS"
  for arg in "$@"; do
    case "$arg" in
      *:/tmp/openclaw-limits-summary.md)
        printf 'container resource warning\\n' > "\${arg%:/tmp/openclaw-limits-summary.md}"
        ;;
    esac
  done
  printf '::warning file=scripts/e2e/kitchen-sink-rpc-walk.mts,line=1,col=0,title=RSS::fixture overage\\n'
  return "$FIXTURE_RUN_STATUS"
}
docker_e2e_sample_stats_until_exit() {
  printf '{"MemUsage":"128MiB / 2GiB","CPUPerc":"1%%"}\\n' > "$3"
}
docker_e2e_print_log() { cat "$1"; }
`,
    );
    const summary = join(root, "summary.md");
    const args = join(root, "args.txt");
    const result = spawnSync("/bin/bash", [runner], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "true",
        GITHUB_STEP_SUMMARY: summary,
        TMPDIR: root,
        FIXTURE_ARGS: args,
        FIXTURE_RUN_STATUS: String(runStatus),
      },
    });

    expect(result.status, result.stderr).toBe(runStatus);
    expect(result.stdout).toContain("::warning file=scripts/e2e/kitchen-sink-rpc-walk.mts");
    const dockerArgs = readFileSync(args, "utf8");
    expect(dockerArgs).toContain("GITHUB_ACTIONS\n");
    expect(dockerArgs).toContain("GITHUB_STEP_SUMMARY=/tmp/openclaw-limits-summary.md\n");
    expect(readFileSync(summary, "utf8")).toContain("container resource warning");
  });
});
