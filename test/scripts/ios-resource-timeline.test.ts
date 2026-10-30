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

function run(
  output: string,
  source: string,
  env: NodeJS.ProcessEnv = {},
  preload?: string,
  command = [process.execPath, "--input-type=module", "-e", source],
) {
  return spawnSync(
    process.execPath,
    [...(preload ? ["--import", preload] : []), script, "--output", output, "--", ...command],
    {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, OPENCLAW_IOS_RESOURCE_DIAGNOSTICS: "1", ...env },
    },
  );
}
const recordsAt = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const endRecord = (output: string, code: number | null, signal: string | null = null) =>
  expect(recordsAt(output).at(-1)).toMatchObject({ type: "end", code, signal });

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
    const records = recordsAt(output);
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
    const result = run(output, "", {}, undefined, [path.join(root, "missing-workload")]);
    expect(result.status).toBe(127);
    expect(result.error).toBeUndefined();
    endRecord(output, 127);
  });

  posixIt(
    "limits process polling and stops it after a timeout while retaining host metrics and sanitized attribution",
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
      let now = 0, hostObservations = 0;
      const processProbeTimes = [];
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(performance, "now", { value: () => now });
      globalThis.setTimeout = (callback, delay) => {
        if (hostObservations === 24) {
          writeFileSync(${JSON.stringify(complete)}, JSON.stringify(processProbeTimes));
          return;
        }
        return setImmediate(() => { now += delay; callback(); });
      };
      globalThis.clearTimeout = clearImmediate;
      childProcess.execFile = (_file, args, _options, callback) => {
        let error = null, stdout = "";
        if (args.includes("/usr/bin/vm_stat")) {
          hostObservations += 1;
          if (hostObservations === 2) now += 75_000;
          stdout = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\\nPages free: " + hostObservations + ".";
        }
        if (args.includes("/usr/sbin/sysctl")) stdout = "1";
        if (args.includes("/bin/ps")) {
          processProbeTimes.push(now);
          if (processProbeTimes.length === 4) error = new Error("probe unavailable");
          else if (processProbeTimes.length === 6) error = Object.assign(new Error("probe timeout"), { killed: true });
          else {
            const runtime = "/Library/Developer/CoreSimulator/Volumes/iOS_private/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS.simruntime/Contents/Resources/RuntimeRoot";
            const row = (pid, ppid, rate, rss, state, command) => [pid, ppid, (now * rate / 1_000).toFixed(2), rss, state, command].join(" ");
            const cryptex = "/private/var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-v24.1.434.0.private-runtime/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS.simruntime/Contents/Resources/RuntimeRoot";
            stdout = [
              row(42, 1, 1, 1024, "R", "/usr/bin/xcodebuild"),
              row(80, 1, 0, 1, "S", "/Applications/Xcode_27.app/Contents/Developer/usr/libexec/launchd_sim"),
              row(81, 80, 0.5, 1024, "R", runtime + "/System/Library/Frameworks/CoreSpotlight.framework/CoreSpotlightService"),
              row(82, 80, 0.33, 500000, "U", runtime + "/private-api-token"),
              row(83, 80, 0.001, 1, "S", cryptex + "/usr/libexec/modelcatalogd"),
              row(84, 80, 0.01, 1, "S", cryptex + "/System/Library/Frameworks/CoreSpotlight.framework/CoreSpotlightService"),
              row(85, 80, 0.4, 1024, "S", cryptex + "/usr/libexec/duetexpertd"),
              row(86, 80, 0.001, 1, "S", "/Library/Developer/CoreSimulator/Devices/private-device/data/RuntimeRoot/usr/libexec/private-device-token"),
              row(87, 80, 0.001, 1, "S", runtime + "/System/Library/../../private-container-token"),
              row(88, 80, 0.001, 1, "S", runtime + "/Applications/private-app-token.app/private-app-token"),
              row(89, 80, 0.001, 1, "S", runtime + "/usr/libexec/private-non-ascii-é"),
              row(101, 80, 0.001, 1, "S", runtime + "/usr/libexec/" + "private-oversize-".repeat(8)),
              row(102, 80, 0.001, 1, "S", "/private/app-container/duetexpertd"),
              ...Array.from({ length: 8 }, (_, i) => row(90 + i, 1, 0.1 + i / 100, 2048, "S", "/usr/libexec/cfprefsd")),
            ].join("\\n");
          }
        }
        setImmediate(() => callback(error, stdout));
        return { kill() {} };
      };
      syncBuiltinESMExports();
    `,
      );
      const result = run(
        output,
        `
        import { existsSync, watch } from "node:fs";
        const finish = () => {
          if (existsSync(${JSON.stringify(complete)})) { watcher.close(); process.exit(23); }
        };
        const watcher = watch(${JSON.stringify(root)}, finish);
        finish();
      `,
        { OPENCLAW_IOS_RESOURCE_DIAGNOSTICS: "1" },
        preload,
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(23);
      expect(result.stderr).toBe("");
      expect(JSON.parse(readFileSync(complete, "utf8"))).toEqual([
        0, 90_000, 150_000, 210_000, 270_000, 330_000,
      ]);
      const raw = readFileSync(output, "utf8");
      expect(raw).not.toMatch(
        /private-api-token|private-runtime|private-device-token|private-container-token|private-app-token|private-non-ascii|private-oversize|app-container|iOS_private|RuntimeRoot|\/usr\/|\/Applications\//u,
      );
      const records = recordsAt(output);
      const samples = records.filter((record) => record.type === "sample");
      expect(records[0]).toMatchObject({ intervalMs: 15_000, processSampleIntervalMs: 60_000 });
      expect(samples).toHaveLength(24);
      expect(samples.map((sample) => sample.host.memory.freeBytes)).toEqual(
        Array.from({ length: 24 }, (_, index) => (index + 1) * 16_384),
      );
      expect(samples.every((sample) => sample.host.pressureLevel === 1)).toBe(true);
      const attempted = samples.filter((sample) =>
        ["ok", "unavailable", "timeout"].includes(sample.probes.ps.outcome),
      );
      expect(
        attempted.map((sample) => [
          sample.processes
            .filter((row: { pid: number }) => row.pid === 42)
            .map((row: { cpuPercent: number | null }) => row.cpuPercent),
          sample.processIntervalMs,
        ]),
      ).toEqual([
        [[null], null],
        [[100], 90_000],
        [[100], 60_000],
        [[], 60_000],
        [[null], null],
        [[], 60_000],
      ]);
      for (const index of [2, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20, 21, 22, 23]) {
        expect(samples[index]).toMatchObject({
          probes: { ps: { wallMs: 0, outcome: index < 18 ? "not-due" : "disabled-after-timeout" } },
          processes: [],
          processSummary: null,
          processIntervalMs: null,
        });
      }
      for (const [pid, role] of [
        [81, "CoreSpotlightService"],
        [82, "other"],
      ] as const) {
        expect(samples[1].processes.find((row: { pid: number }) => row.pid === pid)).toMatchObject({
          role,
          origin: "simulator-runtime",
          parentRole: "launchd_sim",
        });
      }
      expect(samples[1].processes.map((row: { pid: number }) => row.pid)).not.toContain(83);
      expect(samples[1].processSummary).toMatchObject({
        count: 21,
        runnableCount: 2,
        uninterruptibleCount: 1,
      });
      const groups = samples[1].processSummary.groups;
      for (const [role, count, cpuDeltaMs, origin] of [
        ["CoreSpotlightService", 2, 45_900, "simulator-runtime"],
        ["modelcatalogd", 1, 90, "simulator-runtime"],
        ["launchd_sim", 1, 0, "xcode"],
        ["duetexpertd", 1, 36_000, "simulator-runtime"],
      ]) {
        expect(groups).toContainEqual({ role, count, cpuDeltaMs, origin, cpuObservedCount: count });
      }
      expect(groups.filter((group: { role: string }) => group.role === "duetexpertd")).toHaveLength(
        1,
      );
      for (const [index, outcome] of [
        [3, "unavailable"],
        [5, "timeout"],
      ] as const) {
        expect(attempted[index]).toMatchObject({
          probes: { ps: { outcome } },
          processSummary: null,
        });
      }
      expect(
        attempted[4].processSummary.groups.every(
          (group: { cpuObservedCount: number }) => group.cpuObservedCount === 0,
        ),
      ).toBe(true);
      endRecord(output, 23);
    },
  );

  posixIt("retains the child's terminating signal", () => {
    const output = path.join(tempDirs.make("ios-resource-timeline-"), "timeline.jsonl");
    const result = run(output, `process.kill(process.pid, "SIGTERM");`);
    expect(result.signal).toBe("SIGTERM");
    expect(result.status).toBeNull();
    endRecord(output, null, "SIGTERM");
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
