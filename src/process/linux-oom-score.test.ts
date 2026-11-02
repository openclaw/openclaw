import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  prepareOomScoreAdjustedSpawn as prepareSpawn,
  prepareOomScoreAdjustedSpawnPreservingExecEnv as preparePreservingEnv,
  resolveOomScoreWrappedCommand,
  spawnOomScoreAdjusted,
  type OomScoreAdjustedSpawn,
} from "./linux-oom-score.js";

const wrapScript = 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"';
const carrierPrefix = "OC_INTERNAL_OOM_EXEC_";
const linux = { platform: "linux", env: {}, shellAvailable: () => true } as const;
const bashAvailable = fs.existsSync("/bin/bash");
const policies = [preparePreservingEnv, prepareSpawn] as const;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function spawnPrepared(prepared: OomScoreAdjustedSpawn, bashAsSh = false) {
  return spawnSync(prepared.wrapped && bashAsSh ? "/bin/bash" : prepared.command, prepared.args, {
    argv0: prepared.wrapped && bashAsSh ? "sh" : prepared.argv0,
    env: prepared.env,
    encoding: "utf8",
  });
}

it.each(policies)("attributes an owner-prepared wrapper to the final executable", (prepare) => {
  const prepared = prepare("/usr/bin/node", ["run.js"], linux);
  expect(resolveOomScoreWrappedCommand(prepared.command, prepared.args)).toBe("/usr/bin/node");
  expect(
    resolveOomScoreWrappedCommand(prepared.command, [
      prepared.args[0]!,
      prepared.args[1]! + "; printf user-script",
      ...prepared.args.slice(2),
    ]),
  ).toBeUndefined();
});

it.each([
  { command: "/bin/bash", args: ["-c", wrapScript, "node"] },
  { command: "/bin/sh", args: ["-lc", wrapScript, "node"] },
  { command: "/bin/sh", args: ["-c", "exec node", "node"] },
  { command: "/bin/sh", args: ["-c", wrapScript] },
  { command: "/bin/sh", args: ["-c", wrapScript, ""] },
])("rejects unrelated/incomplete wrapper ($command, $args)", ({ command, args }) => {
  expect(resolveOomScoreWrappedCommand(command, args)).toBeUndefined();
});

it("adjusts a distinct child argv0 without a shell", () => {
  const argv0 = "/opt/shims/claude";
  const prepared = prepareSpawn("/usr/bin/mise", ["-p"], {
    ...linux,
    argv0,
    shellAvailable: () => false,
  });
  expect(prepared).toMatchObject({ argv0, wrapped: false, afterSpawn: expect.any(Function) });
  const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
  prepared.afterSpawn?.(4321);
  expect(write).toHaveBeenCalledWith("/proc/4321/oom_score_adj", "1000");
});

it("inherits the parent opt-out through sanitized child environments unless explicitly overridden", () => {
  vi.stubEnv("OPENCLAW_CHILD_OOM_SCORE_ADJ", "0");
  const options = { ...linux, argv0: "/opt/shims/claude" };
  expect(prepareSpawn("/usr/bin/node", [], options)).not.toHaveProperty("afterSpawn");
  expect(
    prepareSpawn("/usr/bin/node", [], {
      ...options,
      env: { OPENCLAW_CHILD_OOM_SCORE_ADJ: "1" },
    }),
  ).toHaveProperty("afterSpawn");
});

it("does not double-wrap an adjusted command", () => {
  const args = ["-c", wrapScript, "/usr/bin/node", "run.js"];
  const env = {
    PATH: "/usr/bin",
    BASH_ENV: "/tmp/bashenv",
    ENV: "/tmp/env",
    CDPATH: "/tmp",
    SHELLOPTS: "xtrace",
    BASHOPTS: "extdebug",
    PS4: "trace",
    "BASH_FUNC_echo%%": "() { :; }",
  };
  expect(prepareSpawn("/bin/sh", args, { ...linux, env })).toEqual({
    command: "/bin/sh",
    args,
    env: { PATH: "/usr/bin" },
    wrapped: true,
  });
});

it("does not pass command names that look like shell options to exec", () => {
  expect(prepareSpawn("-p", ["node"], linux)).toMatchObject({
    command: "-p",
    args: ["node"],
    wrapped: false,
  });
});

it("preserves native ENOENT for missing plugin commands", async () => {
  const child = spawnOomScoreAdjusted("/openclaw-nonexistent-oom-test-command", [], {
    stdio: "ignore",
  });
  await expect(once(child, "spawn")).rejects.toMatchObject({ code: "ENOENT" });
});

it.runIf(process.platform === "linux").each([undefined, "/opt/shims/claude"])(
  "sets the child OOM score while preserving argv0 %s and the parent score",
  async (argv0) => {
    const parentScore = fs.readFileSync("/proc/self/oom_score_adj", "utf8");
    const child = spawnOomScoreAdjusted(
      process.execPath,
      [
        "-e",
        'process.stdin.once("data", () => process.stdout.end(JSON.stringify({ argv0: process.argv0, score: require("node:fs").readFileSync("/proc/self/oom_score_adj", "utf8").trim() })))',
      ],
      { argv0, env: { ...process.env, OPENCLAW_CHILD_OOM_SCORE_ADJ: "1" }, stdio: "pipe" },
    );
    const closed = once(child, "close");
    try {
      await once(child, "spawn");
      let output = "";
      child.stdout!.on("data", (chunk) => {
        output += chunk;
      });
      child.stdin!.end("ready");
      expect(await closed).toEqual([0, null]);
      expect(JSON.parse(output)).toEqual({ argv0: argv0 ?? process.execPath, score: "1000" });
      expect(fs.readFileSync("/proc/self/oom_score_adj", "utf8")).toBe(parentScore);
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  },
);

it("falls back to direct spawn on a defined carrier collision", () => {
  const env = {
    PATH: "/usr/bin",
    BASH_ENV: "/tmp/bashenv",
    [`${carrierPrefix}ENV`]: "reserved",
  };
  const result = preparePreservingEnv("/usr/bin/node", ["run.js"], { ...linux, env });
  expect(result).toMatchObject({ command: "/usr/bin/node", args: ["run.js"], wrapped: false });
  expect(result.env).toBe(env);
});

it.runIf(process.platform !== "win32")("restores exact env only for the final executable", () => {
  const tempDir = tempDirs.make("openclaw-oom-");
  const startupMarkerPath = path.join(tempDir, "wrapper-startup-marker");
  const bashEnvPath = path.join(tempDir, "bash-env.sh");
  fs.writeFileSync(bashEnvPath, `printf touched > "${startupMarkerPath}"\n`);
  const restored = {
    BASH_ENV: bashEnvPath,
    ENV: "",
    CDPATH: "line1\nline2",
    PS4: "final-trace-prefix",
  };
  const script = `process.stdout.write(JSON.stringify({
          values:Object.fromEntries(${JSON.stringify(Object.keys(restored))}.map(key=>[key,process.env[key]])),
          carrierKeys:Object.keys(process.env).filter(key=>key.startsWith("${carrierPrefix}"))
        }))`;
  const prepared = preparePreservingEnv(process.execPath, ["-e", script], {
    ...linux,
    env: { PATH: process.env.PATH, ...restored },
  });
  const child = spawnPrepared(prepared);
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ values: restored, carrierKeys: [] });
  expect(fs.existsSync(startupMarkerPath)).toBe(false);
});

const secret = "review-secret-carried-value";
for (const attack of ["xtrace startup", "imported functions"]) {
  it
    .runIf(bashAvailable && (attack === "xtrace startup" || process.platform === "linux"))
    .each(policies)(`protects Bash-as-sh ${attack} with %s`, (prepare) => {
    const markerPath = path.join(tempDirs.make("openclaw-oom-"), "shell-marker");
    const env = {
      PATH: process.env.PATH,
      ...(attack === "xtrace startup"
        ? {
            BASH_ENV: secret,
            SHELLOPTS: "braceexpand:hashall:interactive-comments:xtrace",
            PS4: `$(printf touched > "${markerPath}")trace `,
          }
        : {
            "BASH_FUNC_echo%%": `() { printf touched > "${markerPath}"; builtin echo "$@"; }`,
          }),
    };
    const prepared = prepare(process.execPath, ["-e", ""], { ...linux, env });
    const child = spawnPrepared(prepared, true);
    expect(child.status).toBe(0);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(prepared.wrapped).toBe(prepare === prepareSpawn);
    expect(child.stderr).not.toContain(secret);
    expect(child.stderr).not.toContain(`${carrierPrefix}BASH_ENV`);
    if (prepare === preparePreservingEnv) {
      expect(prepared.env).toBe(env);
    }
  });
}
