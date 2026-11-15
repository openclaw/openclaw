import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { expectStatus, readJson, writeJson } from "./upgrade-survivor-io.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
const owner = resolve("scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh");
function fixture() {
  const home = tempDirs.make("survivor-stop-policy-");
  const env = { HOME: home, npm_config_prefix: home, PATH: process.env.PATH };
  const run = (command: string, args: string[]) =>
    spawnSync(command, args, { env, encoding: "utf8" });
  expectStatus(
    run("bash", [
      "-c",
      'set -euo pipefail; source "$1"; install_update_restart_systemctl_shim',
      "fixture",
      owner,
    ]),
  );
  const unit = join(home, ".config/systemd/user/openclaw-gateway.service");
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  const systemctl = (...args: string[]) => run(join(home, "bin/systemctl"), ["--user", ...args]);
  const manager = (...args: string[]) =>
    run(process.execPath, [join(home, "bin/systemd-fixture.mjs"), ...args]);
  const writeUnit = (seconds: string | number, extra = "", command = "/usr/bin/true") =>
    writeFileSync(unit, `[Service]\nExecStart=${command}\nTimeoutStopSec=${seconds}\n${extra}`);
  const reload = () => expectStatus(systemctl("daemon-reload"));
  const show = (properties = "LoadState,TimeoutStopUSec") =>
    systemctl("show", "openclaw-gateway.service", "--no-page", "--property", properties);
  const execute = (_binary: string, args: string[]) => {
    expect(args).toEqual([join(home, "bin/systemd-fixture.mjs"), "stop-context"]);
    const result = manager("stop-context");
    expectStatus(result);
    return result.stdout;
  };
  const outer = (body: string[], ...args: string[]) => {
    const stop = readFileSync(owner, "utf8").match(/stop_gateway\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(stop).toBeDefined();
    return run("bash", ["-c", ["set -euo pipefail", stop, ...body].join("\n"), "fixture", ...args]);
  };
  return { home, unit, systemctl, manager, writeUnit, reload, show, execute, outer };
}

function virtualClock() {
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0;
  let serial = 0;
  return {
    timers,
    get now() {
      return now;
    },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++serial;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    advance(this: void, until: number) {
      while (true) {
        const next = [...timers].toSorted((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) {
          break;
        }
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = until;
    },
  };
}

function runSupervisor(
  f: ReturnType<typeof fixture>,
  {
    readFileSync: read,
    execFileSync = f.execute,
    withCwd = true,
    mixed = false,
  }: {
    readFileSync?: (file: string) => string;
    execFileSync?: (binary: string, args: string[]) => string;
    withCwd?: boolean;
    mixed?: boolean;
  } = {},
) {
  const body = readFileSync(owner, "utf8").split("<<'SUPERVISOR'\n")[1]?.split("\nSUPERVISOR")[0];
  expect(body).toBeDefined();
  const handlers = new Map<string, () => void>();
  const exit = vi.fn();
  const log = vi.fn();
  const files = new Map<string, string>();
  let onClose: ((code: number, signal: string | null) => void) | undefined;
  const spawn = vi.fn(() => ({
    pid: 42,
    on: () => {},
    once: (_event: string, callback: (code: number, signal: string | null) => void) => {
      onClose = callback;
    },
  }));
  const clock = virtualClock();
  const group = { alive: true };
  const signals: Array<[number, string | number]> = [];
  const kill = (pid: number, signal: string | number) => {
    if (!mixed || signal === 0) {
      expect(pid).toBe(-42);
    }
    if (signal !== 0) {
      signals.push([pid, signal]);
    } else if (!group.alive) {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }
  };
  vm.runInNewContext(body!.replace(/^import .*;\n/gm, ""), {
    randomUUID,
    execFileSync,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    spawn,
    fs: {
      openSync: () => 1,
      closeSync: () => {},
      writeSync: log,
      writeFileSync: (file: string, contents: string) => files.set(file, contents),
      renameSync: (from: string, to: string) => files.set(to, files.get(from)!),
      ...(read ? { readFileSync: read } : {}),
    },
    process: {
      pid: 43,
      execPath: process.execPath,
      ...(withCwd ? { cwd: () => "/fixture" } : {}),
      env: {
        OPENCLAW_SYSTEMCTL_SHIM_MANAGER_SCRIPT: join(f.home, "bin/systemd-fixture.mjs"),
        OPENCLAW_SYSTEMCTL_SHIM_EXEC_START: "/usr/bin/true",
        OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG: "/fixture/log",
        OPENCLAW_SYSTEMCTL_SHIM_MANAGER_ENV: "{}",
      },
      hrtime: { bigint: () => 1n },
      exit,
      on: (signal: string, handler: () => void) => handlers.set(signal, handler),
      kill,
    },
  });
  return {
    handlers,
    exit,
    runtime: () => JSON.parse(files.get("/fixture/log.runtime.json")!),
    log,
    spawn,
    clock,
    group,
    signals,
    signalNames: () => signals.map(([, signal]) => signal),
    closeChild: (code: number, signal: string | null) => onClose!(code, signal),
  };
}

describe.skipIf(process.platform === "win32")("survivor loaded stop policy", () => {
  it("reports the loaded stop policy until daemon-reload", () => {
    const { unit, systemctl, manager, show: query, writeUnit, reload } = fixture();
    expect(query().stdout).toBe("LoadState=not-found\n");
    writeUnit(330);
    reload();
    expect(query()).toMatchObject({
      status: 0,
      stdout: "LoadState=loaded\nTimeoutStopUSec=330s\n",
    });
    expect(query("TimeoutStopUSec,InvocationID,LoadState")).toMatchObject({
      status: 0,
      stdout: "LoadState=loaded\nTimeoutStopUSec=330s\nInvocationID=\n",
    });
    expect(manager("stop-timeout-ms").stdout).toBe("330000\n");
    writeUnit(30);
    expect(query().stdout).toContain("TimeoutStopUSec=330s");
    expect(manager("stop-timeout-ms").stdout).toBe("330000\n");
    reload();
    expect(query().stdout).toContain("TimeoutStopUSec=30s");
    expect(manager("stop-timeout-ms").stdout).toBe("30000\n");
    writeUnit("invalid");
    expect(systemctl("daemon-reload").status).not.toBe(0);
    expect(query().stdout).toContain("TimeoutStopUSec=30s");
    expect(manager("stop-timeout-ms").stdout).toBe("30000\n");
    rmSync(unit);
    const runtime = query(
      "Id,LoadState,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent",
    );
    expectStatus(runtime);
    expect(runtime.stdout).toContain("LoadState=loaded");
    expect(query().stdout).toContain("TimeoutStopUSec=30s");
    reload();
    expect(query().stdout).toBe("LoadState=not-found\n");
    expect(manager("stop-timeout-ms").status).not.toBe(0);
  });

  it.each([
    { policy: "", value: "90000", display: "90s" },
    { policy: "TimeoutStopSec=0", value: "Infinity", display: "infinity" },
    { policy: "TimeoutStopSec=infinity", value: "Infinity", display: "infinity" },
    ...["-1", "bogus", "1ms", "2147484", "9".repeat(400), "30\nTimeoutStopSec=330"].map(
      (policy) => ({
        policy: "TimeoutStopSec=" + policy,
        value: "",
        display: "",
      }),
    ),
  ])("admits only supported generated stop policy $policy", ({ policy, value, display }) => {
    const { unit, systemctl, manager } = fixture();
    writeFileSync(unit, "[Service]\nExecStart=/usr/bin/true\n" + policy + "\n");
    const loaded = systemctl("daemon-reload");
    if (!value) {
      expect(loaded.status).not.toBe(0);
      expect(existsSync(unit + ".loaded-unit")).toBe(false);
      return;
    }
    expect(loaded.status).toBe(0);
    expect(manager("stop-timeout-ms")).toMatchObject({ status: 0, stdout: value + "\n" });
    expect(
      systemctl("show", "openclaw-gateway.service", "--property=LoadState,TimeoutStopUSec").stdout,
    ).toBe("LoadState=loaded\nTimeoutStopUSec=" + display + "\n");
  });

  it.each([30, 330, "infinity"] as const)(
    "uses loaded %s seconds for supervisor and outer stop",
    (seconds) => {
      const f = fixture();
      f.writeUnit(seconds);
      f.reload();
      // An un-reloaded edit must not affect either consumer.
      f.writeUnit(1);
      if (seconds === 330) {
        f.writeUnit(30);
        f.reload();
      }
      const { handlers, exit, clock, group, signalNames } = runSupervisor(f, { withCwd: false });
      const { timers, advance } = clock;

      if (seconds === 330) {
        // Repair the manager policy after supervisor launch, before its stop.
        f.writeUnit(330);
        f.reload();
        f.writeUnit(1);
      }
      handlers.get(seconds === 30 ? "SIGINT" : "SIGTERM")!();
      const deadline = seconds === "infinity" ? 400_000 : seconds * 1_000;
      advance(deadline - 1);
      expect(signalNames()).toEqual(["SIGTERM"]);
      expect(exit).not.toHaveBeenCalled();
      advance(deadline);
      expect(signalNames()).toEqual(seconds === "infinity" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
      // Sending SIGKILL is not extinction; settlement waits for the group observer.
      expect(exit).not.toHaveBeenCalled();
      group.alive = false;
      advance(deadline + 25);
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(timers.size).toBe(0);

      const pidFile = join(f.home, "pid");
      writeFileSync(pidFile, "999999\n");
      const outer = f.outer(
        [
          "pid_file=$1; supervisor_script=$1.supervisor; manager_script=$2",
          "ticks=0; kill() { :; }; sleep() { ticks=$((ticks + 1)); }",
          "is_running() { [ $ticks -lt 4000 ]; }",
          "status=0; stop_gateway || status=$?; printf '%s' $ticks; exit $status",
        ],
        pidFile,
        join(f.home, "bin/systemd-fixture.mjs"),
      );
      expectStatus(outer, seconds === "infinity" ? 0 : 1);
      if (seconds !== "infinity") {
        expect(outer.stderr).toContain("retaining process custody");
        expect(existsSync(pidFile)).toBe(true);
      }
      expect(Number(outer.stdout)).toBe(
        seconds === "infinity" ? 4000 : (seconds * 1_000 + 5_000) / 100,
      );
    },
  );

  it.each(["main-exit", "deadline"])(
    "settles detached cgroup members after mixed-mode %s before releasing custody",
    (trigger) => {
      const f = fixture();
      const controlGroup = "/openclaw-gateway.service";
      const runtimePath = join(f.home, "bin/systemd-fixture-runtime.json");
      writeJson(runtimePath, { ...JSON.parse(readFileSync(runtimePath, "utf8")), controlGroup });
      f.writeUnit(30, "KillMode=mixed\n");
      f.reload();
      // Both the signal policy and deadline must come from the loaded definition.
      f.writeUnit(1, "KillMode=control-group\n");
      let descendantAlive = true;
      let lateDescendantAlive = false;
      const { handlers, exit, runtime, spawn, closeChild, clock, group, signals } = runSupervisor(
        f,
        {
          mixed: true,
          readFileSync: (file: string) => {
            if (file === `/sys/fs/cgroup${controlGroup}/cgroup.events`) {
              return `populated ${group.alive || descendantAlive || lateDescendantAlive ? 1 : 0}\n`;
            }
            if (file === `/sys/fs/cgroup${controlGroup}/cgroup.procs`) {
              // PID 45 moved out between enumeration and membership validation.
              return `${group.alive ? "42\n" : ""}${descendantAlive ? "44\n" : ""}45\n${lateDescendantAlive ? "46\n" : ""}`;
            }
            if (/^\/proc\/(42|44|46)\/cgroup$/.test(file)) {
              return `0::${controlGroup}\n`;
            }
            if (file === "/proc/45/cgroup") {
              return "0::/unrelated.service\n";
            }
            const member = /^\/proc\/(42|44|45|46)\/stat$/.exec(file)?.[1];
            if (member) {
              return `${member} (fixture child) S ${Array(18).fill("0").join(" ")} 100 0 0\n`;
            }
            throw new Error(`Unexpected fixture read: ${file}`);
          },
        },
      );
      const { timers, advance } = clock;
      const expectedSignals: Array<[number, string]> = [[42, "SIGTERM"]];
      handlers.get("SIGTERM")!();
      expect(signals).toEqual(expectedSignals);
      expect(timers.size).toBe(2);
      if (trigger === "deadline") {
        advance(29_999);
        expect(signals).toEqual(expectedSignals);
        expect(exit).not.toHaveBeenCalled();
        advance(30_000);
        expectedSignals.push([42, "SIGKILL"], [44, "SIGKILL"]);
        expect(signals).toEqual(expectedSignals);
        expect(exit).not.toHaveBeenCalled();
      }
      group.alive = false;
      closeChild!(0, null);
      advance(clock.now + 25);
      if (trigger === "main-exit") {
        expectedSignals.push([44, "SIGKILL"]);
      }
      expect(signals).toEqual(expectedSignals);
      expect(exit).not.toHaveBeenCalled();
      expect(runtime()).toMatchObject({ pid: 0, groupPid: 42, supervisorPid: 43 });
      // A fork first observed during settlement is owned work too. The previous
      // member stays live, but must not receive a second signal attempt.
      lateDescendantAlive = true;
      advance(clock.now + 25);
      expectedSignals.push([46, "SIGKILL"]);
      expect(signals).toEqual(expectedSignals);
      expect(exit).not.toHaveBeenCalled();
      expect(runtime()).toMatchObject({ pid: 0, groupPid: 42, supervisorPid: 43 });
      descendantAlive = false;
      lateDescendantAlive = false;
      advance(clock.now + 25);
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(runtime()).toMatchObject({ pid: 0, groupPid: 0, supervisorPid: 0 });
      expect(spawn).toHaveBeenCalledOnce();
      expect(timers.size).toBe(0);
    },
  );

  it.each(["signal", "child-close"])(
    "retains custody when the policy read fails during %s drain",
    (entry) => {
      const f = fixture();
      const { handlers, exit, runtime, log, spawn, closeChild, clock, group, signalNames } =
        runSupervisor(f, {
          execFileSync: () => {
            throw new Error("policy read failed");
          },
        });
      const beginDrain = () =>
        entry === "signal" ? handlers.get("SIGTERM")!() : closeChild!(0, null);
      expect(beginDrain).not.toThrow();
      expect(signalNames()).toEqual(["SIGTERM", "SIGKILL"]);
      expect(log.mock.calls.flat().join(" ")).toContain("stop policy read failed");
      expect(exit).not.toHaveBeenCalled();
      expect(runtime()).toMatchObject({ groupPid: 42, supervisorPid: 43 });
      // A failed forced kill cannot turn into a clean exit or restart.
      clock.advance(25);
      expect(exit).not.toHaveBeenCalled();
      group.alive = false;
      clock.advance(50);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(spawn).toHaveBeenCalledOnce();
      const retired = runtime();
      expect(retired).toMatchObject({ pid: 0, groupPid: 0, supervisorPid: 0, stopFailed: true });
      writeJson(join(f.home, "bin/systemctl-shim-gateway.log.runtime.json"), retired);
      const stopped = f.systemctl("stop", "openclaw-gateway.service");
      expect(stopped.status).toBe(1);
      expect(stopped.stderr).toContain("stop policy read failed");
    },
  );

  it.for([false, true])(
    "joins the installed outer stop after removed-unit reload=%s",
    async (removed, { signal }) => {
      const f = fixture();
      const ready = join(f.home, "ready");
      const program = join(f.home, "child.mjs");
      const runtimeFile = join(f.home, "bin/systemctl-shim-gateway.log.runtime.json");
      const runtime = () => readJson(runtimeFile);
      writeFileSync(
        program,
        `${fixtureReceiptClientSource(receipts.endpoint)}
import fs from "node:fs";
process.on("SIGTERM", () => ${removed ? "{}" : "process.exit(0)"});
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
sendReceipt(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000);`,
      );
      f.writeUnit(330, "", `${JSON.stringify(process.execPath)} ${JSON.stringify(program)}`);
      try {
        const started = f.systemctl("start", "openclaw-gateway.service");
        expectStatus(started);
        await withinTest(receipts.waitFor(ready, "ready"), signal);
        const pid = Number(readFileSync(ready, "utf8"));
        if (removed) {
          rmSync(f.unit);
          f.reload();
          expect(existsSync(f.unit + ".loaded-unit")).toBe(false);
        }
        const stopped = f.systemctl("stop", "openclaw-gateway.service");
        expectStatus(stopped, removed ? 1 : 0);
        expect(runtime()).toMatchObject({
          pid: 0,
          groupPid: 0,
          supervisorPid: 0,
          stopFailed: removed,
        });
        expect(() => process.kill(-pid, 0)).toThrow();
        if (removed) {
          expect(stopped.stderr).toContain("stop policy read failed");
        }
      } finally {
        if (existsSync(runtimeFile)) {
          const owned = runtime();
          // Retire only fixture-owned PIDs; stop then joins the supervisor's zero-ID receipt.
          for (const [pid, killSignal] of [
            [owned.supervisorPid, "SIGTERM"],
            [-owned.groupPid, "SIGKILL"],
          ] as const) {
            if (!pid) {
              continue;
            }
            try {
              process.kill(pid, killSignal);
            } catch {}
          }
          if (owned.supervisorPid || owned.groupPid) {
            f.systemctl("stop", "openclaw-gateway.service");
          }
          expect(runtime()).toMatchObject({ pid: 0, supervisorPid: 0, groupPid: 0 });
        } else {
          f.systemctl("stop", "openclaw-gateway.service");
        }
      }
    },
  );

  it.each([
    ["zombie reaped between probes", "zombie", 1],
    ["reaped process", "gone", 1],
    ["live process without procfs", "live", 0],
  ] as const)("reports is_running for a %s (fixture state %s)", (_name, initial, expected) => {
    const f = fixture();
    const probe = readFileSync(owner, "utf8").match(/is_running\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(probe).toBeDefined();
    const pidFile = join(f.home, "pid");
    writeFileSync(pidFile, "4242\n");
    // The container reaper may retire an exited supervisor right after the first probe.
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          probe!,
          'pid_file=$1; state=$2; zombie_stat=$3; reap() { [ "$state" != zombie ] || state=gone; }',
          'kill() { local alive=0; [ "$1" = -0 ] && [ "$state" != gone ] || alive=1; reap; return $alive; }',
          'cat() { if [ "$1" != /proc/4242/stat ]; then command cat "$@"; return; fi',
          '  local found=1; [ "$state" != zombie ] || { printf "%s\\n" "$zombie_stat"; found=0; }',
          "  reap; return $found; }",
          "status=0; is_running || status=$?; printf '%s' $status",
        ].join("\n"),
        "fixture",
        pidFile,
        initial,
        `4242 (node) Z${" 0".repeat(49)}`,
      ],
      { encoding: "utf8" },
    );
    expectStatus(result);
    expect(result.stdout).toBe(String(expected));
  });

  it.each([true, false])(
    "keeps outer policy lookup failure nonzero with supervisor active=%s",
    (active) => {
      const f = fixture();
      const pid = join(f.home, "pid");
      const supervisor = join(f.home, "supervisor");
      const signals = join(f.home, "signals");
      writeFileSync(pid, "424242\n");
      writeFileSync(supervisor, "owned");
      const result = f.outer(
        [
          "pid_file=$1; supervisor_script=$2; signal_log=$3; manager_script=fixture-manager",
          'ticks=0; kill() { printf "%s\\n" "$*" >> "$signal_log"; }; sleep() { ticks=$((ticks+1)); }',
          'node() { [ "$2" != stop-timeout-ms ] || return 17; [ "$2" = check-stopped ]; }',
          active ? "is_running() { return 0; }" : "is_running() { return 1; }",
          'status=0; stop_gateway || status=$?; printf "%s %s\\n" "$status" "$ticks"',
        ],
        pid,
        supervisor,
        signals,
      );
      expectStatus(result);
      expect(result.stdout.trim()).toBe(active ? "1 50" : "17 0");
      expect(readFileSync(signals, "utf8").trim().split("\n")).toEqual(["-0 424242", "424242"]);
      expect(existsSync(pid)).toBe(true);
      expect(existsSync(supervisor)).toBe(true);
    },
  );
});
