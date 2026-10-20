import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const script = path.resolve("scripts/ios-resource-timeline.mjs");
const moduleUrl = JSON.stringify(pathToFileURL(script).href);
const posixIt = process.platform === "win32" ? it.skip : it;

function run(output: string, source: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    [script, "--output", output, "--", process.execPath, "--input-type=module", "-e", source],
    {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, OPENCLAW_IOS_RESOURCE_DIAGNOSTICS: "1", ...env },
    },
  );
}

describe("iOS resource timeline workload boundary", () => {
  it.each([
    ["private-api-token", "other"],
    ["qualification-native-build", "qualification-native-build"],
  ])("preserves workload exit and output while sanitizing phase %s", (phase, expected) => {
    const output = path.join(tempDirs.make("ios-resource-timeline-"), "timeline.jsonl");
    const result = run(
      output,
      `
      import { markIosResourcePhase } from ${moduleUrl};
      markIosResourcePhase(${JSON.stringify(phase)});
      console.log(process.env.OPENCLAW_IOS_RESOURCE_PHASE_PATH);
      process.exit(23);
    `,
    );
    expect(result.status).toBe(23);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(existsSync(result.stdout.trim())).toBe(false);
    const raw = readFileSync(output, "utf8");
    expect(raw).not.toMatch(/private-api-token|--input-type|OPENCLAW_IOS_RESOURCE_PHASE_PATH/u);
    const records = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({
      type: "start",
      collectorCpuScope: "node-only-excludes-observation-subprocesses",
    });
    expect(records.at(-1)).toMatchObject({ type: "end", phase: expected, code: 23, signal: null });
  });

  it.each(["disabled", "unwritable"])("runs the workload when diagnostics are %s", (mode) => {
    const parent = path.join(tempDirs.make("ios-resource-timeline-"), "parent");
    if (mode === "unwritable") {
      writeFileSync(parent, "ordinary file");
    }
    const output = path.join(parent, "timeline.jsonl");
    const result = run(
      output,
      `console.log(process.env.OPENCLAW_IOS_RESOURCE_PHASE_PATH ?? "no collector"); process.exit(17);`,
      {
        OPENCLAW_IOS_RESOURCE_DIAGNOSTICS: mode === "disabled" ? "0" : "1",
        OPENCLAW_IOS_RESOURCE_PHASE_PATH: "/stale/parent/collector",
      },
    );
    expect(result.status).toBe(17);
    expect(result.stdout).toBe("no collector\n");
    expect(existsSync(output)).toBe(false);
  });

  it("reports a failed workload spawn without waiting on diagnostics", () => {
    const root = tempDirs.make("ios-resource-timeline-");
    const output = path.join(root, "timeline.jsonl");
    const result = spawnSync(
      process.execPath,
      [script, "--output", output, "--", path.join(root, "missing-workload")],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(result.status).toBe(127);
    expect(result.error).toBeUndefined();
    expect(JSON.parse(readFileSync(output, "utf8").trim().split("\n").at(-1)!)).toMatchObject({
      type: "end",
      code: 127,
      signal: null,
    });
  });

  posixIt(
    "uses process observation intervals and resets CPU baseline after a missing probe",
    () => {
      const root = tempDirs.make("ios-resource-timeline-");
      const output = path.join(root, "timeline.jsonl");
      const complete = path.join(root, "complete");
      const preload = path.join(root, "native-probes.mjs");
      // Only this subprocess has accelerated time and synthetic native observations.
      writeFileSync(
        preload,
        `
      import childProcess from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      let now = 0, observations = 0;
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(performance, "now", { value: () => now });
      globalThis.setTimeout = (callback, delay) => {
        if (observations === 6) {
          writeFileSync(${JSON.stringify(complete)}, "complete");
          return;
        }
        return setImmediate(() => { now += delay; callback(); });
      };
      globalThis.clearTimeout = clearImmediate;
      childProcess.execFile = (_file, args, _options, callback) => {
        let error = null, stdout = "";
        if (args.includes("/usr/bin/vm_stat") && observations === 1) now += 75_000;
        if (args.includes("/bin/ps")) {
          if (observations === 3) error = Object.assign(new Error("probe unavailable"), { killed: true });
          else stdout = "42 1 " + (now / 1_000).toFixed(2) + " 1024 R /usr/bin/xcodebuild\\n";
          observations += 1;
        }
        setImmediate(() => callback(error, stdout));
        return { kill() {} };
      };
      syncBuiltinESMExports();
    `,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          preload,
          script,
          "--output",
          output,
          "--",
          process.execPath,
          "--input-type=module",
          "-e",
          `
        import { existsSync, watch } from "node:fs";
        const finish = () => {
          if (existsSync(${JSON.stringify(complete)})) { watcher.close(); process.exit(23); }
        };
        const watcher = watch(${JSON.stringify(root)}, finish);
        finish();
      `,
        ],
        {
          encoding: "utf8",
          timeout: 5_000,
          env: { ...process.env, OPENCLAW_IOS_RESOURCE_DIAGNOSTICS: "1" },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(23);
      expect(result.stderr).toBe("");
      const records = readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const samples = records.filter((record) => record.type === "sample");
      expect(
        samples.map((sample) =>
          sample.processes.map((row: { cpuPercent: number | null }) => row.cpuPercent),
        ),
      ).toEqual([[null], [100], [100], [], [null], [100]]);
      expect(samples[3].probes.ps.outcome).toBe("timeout");
      expect(records.at(-1)).toMatchObject({ type: "end", code: 23, signal: null });
    },
  );

  posixIt("retains the child's terminating signal", () => {
    const output = path.join(tempDirs.make("ios-resource-timeline-"), "timeline.jsonl");
    const result = run(output, `process.kill(process.pid, "SIGTERM");`);
    expect(result.signal).toBe("SIGTERM");
    expect(result.status).toBeNull();
    expect(JSON.parse(readFileSync(output, "utf8").trim().split("\n").at(-1)!)).toMatchObject({
      type: "end",
      code: null,
      signal: "SIGTERM",
    });
  });

  posixIt("forwards cancellation without changing the workload's handled exit", async () => {
    const output = path.join(tempDirs.make("ios-resource-timeline-"), "timeline.jsonl");
    const child = spawn(
      process.execPath,
      [
        script,
        "--output",
        output,
        "--",
        process.execPath,
        "-e",
        `
      process.on("SIGTERM", () => { console.log("cancelled"); process.exit(19); });
      process.stdin.resume(); console.log("ready");
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout === "ready\n") {
        child.kill("SIGTERM");
      }
    });
    try {
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      expect(result).toEqual({ code: 19, signal: null });
      expect(stdout).toBe("ready\ncancelled\n");
    } finally {
      child.kill("SIGKILL");
      child.stdin.destroy();
    }
  });
});
