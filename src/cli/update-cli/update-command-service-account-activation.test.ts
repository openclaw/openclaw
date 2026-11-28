import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { updateSystemServiceAsAccount } from "./update-command-service-account-activation.js";
import type { ServiceAccountExecution } from "./update-command-service-account-run.js";

// systemd itself is not available to unit tests: the native start/stop owners and the unit
// read are fed observed states. The service account's process is a runuser stand-in that
// answers each command the way an account could, including with hostile output.
const native = vi.hoisted(() => ({
  events: [] as string[],
  unit: { active: "active", pid: 0 },
  startPid: 0,
  scheduled: [] as string[][],
  plan: undefined as ServiceAccountExecution | undefined,
  stopIgnored: false,
  scheduleFails: false,
  cgroupPopulated: false,
  /** After start, the unit keeps exiting and systemd restarts it. */
  crashLoop: false,
  restarts: 0,
}));
// Unit selection and account resolution have their own tests in the admission suite.
vi.mock("./update-command-admit-service-account.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-admit-service-account.js")>()),
  inspectSystemServiceAccountForAdmission: async () => native.plan,
}));
vi.mock("../../daemon/systemd-service-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-service-identity.js")>()),
  captureSystemdServiceIdentity: async () => ({ unitName: "openclaw-gateway.service" }),
}));
vi.mock("../../daemon/systemd-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-lifecycle.js")>()),
  stopSystemdService: async () => {
    native.events.push("stop");
    if (!native.stopIgnored) {
      native.unit = { active: "inactive", pid: 0 };
    }
  },
  startSystemdService: async () => {
    native.events.push("start");
    native.unit = native.crashLoop
      ? { active: "activating", pid: 0 }
      : { active: "active", pid: native.startPid };
  },
}));
vi.mock("../../daemon/systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-exec.js")>()),
  execSystemctl: async () => {
    if (native.crashLoop && native.unit.active === "activating") {
      native.restarts += 2;
    }
    return {
      code: 0,
      stdout: `ActiveState=${native.unit.active}\nMainPID=${native.unit.pid}\nControlGroup=${native.unit.active === "active" ? "/system.slice/openclaw-gateway.service" : ""}\nNRestarts=${native.restarts}\n`,
      stderr: "",
    };
  },
}));
vi.mock("../../daemon/systemd-cgroup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-cgroup.js")>()),
  isSystemdControlGroupEmpty: (controlGroup: string) =>
    controlGroup === "/system.slice/openclaw-gateway.service" && !native.cgroupPopulated,
}));
vi.mock("../../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../process/exec.js")>();
  return {
    ...actual,
    runCommandWithTimeout: async (argv: string[], options: unknown) => {
      if (argv[0] === "/usr/bin/systemd-run") {
        native.scheduled.push(argv);
        return { code: native.scheduleFails ? 1 : 0, stdout: "", stderr: "" };
      }
      return actual.runCommandWithTimeout(argv, options as never);
    },
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
const children: ChildProcess[] = [];
let root: string;
let accountDir: string;

/** answers: command -> [exit code, stdout]; "health" covers gateway health. */
function installAccount(
  answers: Record<string, [number, string]>,
  options: { migrationBacksUp?: boolean } = {},
): void {
  accountDir = dirs.make("service-account-steps-");
  if (options.migrationBacksUp ?? true) {
    fs.writeFileSync(path.join(accountDir, "migrate.receipt"), "");
  }
  for (const [command, [code, stdout]] of Object.entries(answers)) {
    fs.writeFileSync(path.join(accountDir, `${command}.code`), String(code));
    fs.writeFileSync(path.join(accountDir, `${command}.out`), stdout);
  }
  const shim = path.join(accountDir, "runuser");
  fs.writeFileSync(
    shim,
    [
      "#!/bin/sh",
      'dir=$(dirname "$0")',
      // -u <account> -- <node> -e <loader> <env file> <entry> <command...>
      'shift 8; command=$1; [ "$command" = gateway ] && command=health; [ "$command" = update ] && command=$2',
      'echo "$command" >> "$dir/calls"',
      // Like the real command: a migration that got as far as its backup leaves a receipt.
      '[ "$command" = migrate ] && [ -f "$dir/migrate.receipt" ] && mkdir -p "$(dirname "$4")" && : > "$4.receipt.json"',
      '[ -f "$dir/$command.code" ] || exit 70',
      'cat "$dir/$command.out"',
      'exit $(cat "$dir/$command.code")',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  native.plan = {
    kind: "switch",
    unitName: "openclaw-gateway.service",
    unitPath: "/etc/systemd/system/openclaw-gateway.service",
    account: "openclaw",
    uid: process.getuid?.() || 1001,
    gid: process.getgid?.() ?? 0,
    runuser: shim,
    home: path.join(accountDir, "home"),
    env: {
      HOME: path.join(accountDir, "home"),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      OPENAI_API_KEY: "unit-only-value",
    },
  };
}

const calls = () =>
  fs.existsSync(path.join(accountDir, "calls"))
    ? fs.readFileSync(path.join(accountDir, "calls"), "utf8").trim().split("\n")
    : [];

// The transient unit runs `node -e <script> <payload>`; it must compile as Node will see it.
const scheduledScripts = () => native.scheduled.map((argv) => argv[argv.indexOf("-e") + 1] ?? "");

const scheduledPayloads = () =>
  native.scheduled.map((argv) => JSON.parse(argv.at(-1) ?? "null") as Record<string, unknown>);

// Like the real commands: Doctor output first, then the result as indented JSON.
const ok = (status: string): [number, string] => [
  0,
  `Doctor: maintenance finish\n{ "status": "not-this-one" }\n${JSON.stringify({ status, receipt: "/x" }, undefined, 2)}\n`,
];

async function activate(budgetMs = 2_000) {
  const result = await updateSystemServiceAsAccount({
    root,
    remainingMs: () => budgetMs,
    warn: () => {},
  });
  if (!result) {
    throw new Error("expected a service account activation");
  }
  return result;
}

beforeEach(() => {
  native.events = [];
  native.unit = { active: "active", pid: process.pid };
  native.scheduled = [];
  native.plan = undefined;
  native.stopIgnored = false;
  native.scheduleFails = false;
  native.cgroupPopulated = false;
  native.crashLoop = false;
  native.restarts = 0;
  root = dirs.make("service-account-release-");
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "index.js"), "setInterval(() => {}, 1000);\n");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.11.16" }),
  );
  // A real process running this release, so its /proc entry identifies the served build.
  const child = spawn(process.execPath, [path.join(root, "dist", "index.js"), "gateway"], {
    stdio: "ignore",
  });
  children.push(child);
  native.startPid = child.pid ?? 0;
});

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  vi.restoreAllMocks();
});

describe("system service update as the unit's account", () => {
  it.runIf(process.platform === "linux")(
    "stops the unit, migrates as the account, starts and verifies the candidate, then settles after the updater",
    async () => {
      installAccount({
        migrate: ok("migrated"),
        health: [0, "{}"],
        finish: ok("finished"),
      });

      const result = await activate();

      expect(result).toMatchObject({ status: "updated" });
      expect(native.events).toEqual(["stop", "start"]);
      // The run is recorded only once the installed updater has settled the package.
      expect(calls()).toEqual(["migrate", "health"]);
      expect(scheduledPayloads()).toMatchObject([
        { mode: "settle", unit: "openclaw-gateway.service" },
      ]);
    },
  );

  it.each([
    { name: "a failed migration", migrate: [1, ok("migrated")[1]] as [number, string] },
    { name: "a success exit without a status", migrate: [0, "done\n"] as [number, string] },
    {
      name: "a status that is not a status word",
      migrate: [0, `${JSON.stringify({ status: "migrated; rm -rf /" })}\n`] as [number, string],
    },
    {
      name: "output beyond its bound",
      migrate: [0, `${"x".repeat(300 * 1024)}\n${ok("migrated")[1]}`] as [number, string],
    },
  ])("restores as the account and never starts the candidate after $name", async ({ migrate }) => {
    installAccount({ migrate, restore: ok("restored") });

    const result = await activate();

    expect(result).toMatchObject({ status: "failed", stateRestored: true });
    // Restoring re-confirms the stop first.
    expect(native.events).toEqual(["stop", "stop"]);
    expect(calls()).toEqual(["migrate", "restore"]);
    // The unit restarts only after the installed updater restored the previous package.
    expect(scheduledPayloads()).toMatchObject([
      {
        // Armed before the migration started.
        mode: "settle",
        driverPid: process.ppid,
        root,
        candidateVersion: "2026.11.16",
        unit: "openclaw-gateway.service",
      },
    ]);
    // The transient unit's argv carries no environment values, only the handoff path.
    expect(JSON.stringify(native.scheduled)).not.toContain("unit-only-value");
    for (const script of scheduledScripts()) {
      expect(() => new vm.Script(script)).not.toThrow();
    }
  });

  it("migrates nothing when the settle step cannot be armed", async () => {
    installAccount({ migrate: ok("migrated"), restore: ok("restored") });
    native.scheduleFails = true;

    const result = await activate();

    expect(result).toMatchObject({ status: "failed", stateRestored: false });
    expect(result.status === "failed" && result.message).toContain("nothing was migrated");
    expect(native.events).toEqual(["stop"]);
    expect(calls()).toEqual([]);
  });

  it("reports unchanged state when the migration failed before its backup", async () => {
    installAccount({ migrate: [1, ""], restore: [1, ""] }, { migrationBacksUp: false });

    const result = await activate();

    expect(result).toMatchObject({ status: "failed", stateRestored: true });
    expect(result.status === "failed" && result.message).toContain("state was not changed");
  });

  it("keeps the unit stopped and the backup when the account cannot restore", async () => {
    installAccount({ migrate: [1, ""], restore: [1, ok("restored")[1]] });

    const result = await activate();

    expect(result).toMatchObject({ status: "failed", stateRestored: false });
    expect(result.status === "failed" && result.message).toContain("update backup is kept");
    // Restoring re-confirms the stop first; the armed settle step retries after the updater.
    expect(native.events).toEqual(["stop", "stop"]);
    expect(scheduledPayloads()).toMatchObject([{ mode: "settle" }]);
  });

  it("keeps the state and the backup when the unit cannot be confirmed stopped", async () => {
    installAccount({ migrate: ok("migrated"), restore: ok("restored") });
    native.stopIgnored = true;

    const result = await activate();

    expect(result).toMatchObject({ status: "failed", stateRestored: false });
    expect(result.status === "failed" && result.message).toContain("nothing was migrated");
    expect(calls()).toEqual([]);
  });

  it("keeps the state when processes survive in the stopped unit's cgroup", async () => {
    // systemd reports the unit inactive, but KillMode= left a process behind.
    native.cgroupPopulated = true;
    installAccount({ migrate: ok("migrated"), restore: ok("restored") });

    const result = await activate();

    expect(result).toMatchObject({ status: "failed", stateRestored: false });
    expect(calls()).toEqual([]);
  });

  it("restores when the started unit does not serve the candidate", async () => {
    // systemd reports a process that does not run this release.
    native.startPid = process.pid;
    installAccount({
      migrate: ok("migrated"),
      health: [0, "{}"],
      restore: ok("restored"),
    });

    const result = await activate(1_500);

    expect(result).toMatchObject({ status: "failed", stateRestored: true });
    expect(result.status === "failed" && result.message).toContain(
      "did not come ready on 2026.11.16",
    );
    expect(native.events).toEqual(["stop", "start", "stop"]);
    expect(calls()).toEqual(["migrate", "restore"]);
  });

  it("restores without waiting out readiness when systemd keeps restarting the candidate", async () => {
    native.crashLoop = true;
    native.restarts = 3;
    installAccount({ migrate: ok("migrated"), health: [0, "{}"], restore: ok("restored") });
    const started = Date.now();

    const result = await activate(10 * 60_000);

    expect(result).toMatchObject({ status: "failed", stateRestored: true });
    expect(result.status === "failed" && result.message).toContain("did not come ready");
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(native.events).toEqual(["stop", "start", "stop"]);
    expect(calls()).toEqual(["migrate", "restore"]);
  });

  it.runIf(process.platform === "linux")(
    "restores when the account's own client cannot reach the started Gateway",
    async () => {
      installAccount({
        migrate: ok("migrated"),
        health: [1, ""],
        restore: ok("restored"),
      });

      const result = await activate(1_500);

      expect(result).toMatchObject({ status: "failed", stateRestored: true });
      expect(native.events).toEqual(["stop", "start", "stop"]);
      expect(calls().at(-1)).toBe("restore");
    },
  );
});

describe("selected unit not run by another account", () => {
  it("does nothing when no system unit runs this installation as another account", async () => {
    await expect(
      updateSystemServiceAsAccount({ root, remainingMs: () => 1_000, warn: () => {} }),
    ).resolves.toBeUndefined();
    expect(native.events).toEqual([]);
  });
});

/**
 * The settle step runs later in a transient root unit. Run the exact scheduled script with
 * stand-ins for systemctl, the package file, the cgroup and the account's answers.
 */
describe("settle step after the installed updater exits", () => {
  type World = {
    version: string;
    buildId?: string;
    receipt?: boolean;
    /** Root's marker that the Doctor child verified the started candidate. */
    verified?: boolean;
    active: string;
    controlGroup?: string;
    cgroupEvents?: string;
    account: Record<string, [number, string]>;
  };

  async function settleScript(): Promise<string> {
    installAccount({ migrate: [1, ""], restore: ok("restored") });
    await activate();
    const script = scheduledScripts()[0];
    if (!script) {
      throw new Error("expected a scheduled settle script");
    }
    return script;
  }

  function runSettle(script: string, mode: "settle" | "start", world: World) {
    const payload = {
      mode,
      driverPid: 1,
      root: "/opt/openclaw",
      candidateVersion: "2026.11.16",
      candidateBuildId: "build-candidate",
      unit: "openclaw-gateway.service",
      runuser: "/usr/sbin/runuser",
      account: "openclaw",
      envFile: "/tmp/handoff/env.json",
      handoffDir: "/tmp/handoff",
      backupRoot: "/var/lib/openclaw/.openclaw-update/x/native",
      controlGroup: "/system.slice/openclaw-gateway.service",
      loader: "loader",
      path: "/usr/bin:/bin",
    };
    const events: string[] = [];
    const fakeFs = {
      readFileSync: (file: string) => {
        if (file === `${payload.root}/package.json`) {
          return JSON.stringify({ version: world.version });
        }
        if (file === `${payload.root}/dist/build-info.json`) {
          return JSON.stringify({ buildId: world.buildId ?? "build-candidate" });
        }
        if (file.endsWith("/cgroup.events") && world.cgroupEvents !== undefined) {
          return world.cgroupEvents;
        }
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      existsSync: (file: string) =>
        file === `${payload.handoffDir}/verified` && world.verified === true,
      rmSync: (dir: string) => events.push(`rm ${dir}`),
      lstatSync: (file: string) => {
        if (file === `${payload.backupRoot}.receipt.json` && world.receipt !== false) {
          return {};
        }
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    };
    const fakeChildProcess = {
      spawnSync: (command: string, args: string[]) => {
        if (command === "/usr/bin/systemctl" && args[0] === "show") {
          return {
            status: 0,
            stdout: args[2] === "ActiveState" ? world.active : (world.controlGroup ?? ""),
          };
        }
        if (command === "/usr/bin/systemctl") {
          events.push(`systemctl ${args.join(" ")}`);
          if (args[0] === "stop") {
            world.active = "inactive";
          }
          return { status: 0 };
        }
        if (command === payload.runuser) {
          const step = args.includes("update")
            ? (args[args.indexOf("update") + 1] ?? "")
            : args.includes("health")
              ? "health"
              : "";
          events.push(`as ${args[1]}: ${step === "health" ? "gateway" : "update"} ${step}`);
          const [status, stdout] = world.account[step] ?? [70, ""];
          return { status, stdout };
        }
        return { status: 0 };
      },
    };
    vm.runInNewContext(script, {
      require: (name: string) => (name === "node:fs" ? fakeFs : fakeChildProcess),
      // The installed updater has exited.
      process: {
        argv: ["node", JSON.stringify(payload)],
        execPath: "/usr/bin/node",
        kill: () => {
          throw new Error("no such process");
        },
      },
      console: { log: (message: string) => events.push(`log ${message}`) },
      setTimeout,
    });
    return events;
  }

  it("records the verified kept update as the account, reading its indented result", async () => {
    const events = runSettle(await settleScript(), "settle", {
      version: "2026.11.16",
      verified: true,
      active: "active",
      account: { finish: ok("finished") },
    });

    expect(events.filter((event) => !event.startsWith("log "))).toEqual([
      "as openclaw: update finish",
      "rm /tmp/handoff",
    ]);
    expect(events.join("\n")).not.toContain("did not confirm");
  });

  it("records a kept update without the marker once the serving unit answers the account", async () => {
    const events = runSettle(await settleScript(), "settle", {
      version: "2026.11.16",
      active: "active",
      account: { health: [0, "{}"], finish: ok("finished") },
    });

    expect(events.filter((event) => !event.startsWith("log "))).toEqual([
      "as openclaw: gateway health",
      "as openclaw: update finish",
      "rm /tmp/handoff",
    ]);
  });

  it.each([
    { name: "the unit is not running", active: "failed", health: [0, "{}"] as [number, string] },
    { name: "the account cannot reach it", active: "active", health: [1, ""] as [number, string] },
  ])(
    "keeps the backup and restores an unverified kept update when $name",
    async ({ active, health }) => {
      // The updater died between the migration and readiness, then kept the candidate.
      const events = runSettle(await settleScript(), "settle", {
        version: "2026.11.16",
        active,
        account: { health, restore: ok("restored"), finish: ok("finished") },
      });

      expect(events).not.toContain("as openclaw: update finish");
      expect(events).toContain("systemctl stop openclaw-gateway.service");
      expect(events).toContain("as openclaw: update restore");
      expect(events).not.toContain("systemctl start openclaw-gateway.service");
    },
  );

  it("restores the state as the account and restarts after the updater restored the package", async () => {
    const events = runSettle(await settleScript(), "settle", {
      version: "2026.11.10",
      active: "active",
      account: { restore: ok("restored") },
    });

    expect(events.filter((event) => !event.startsWith("log "))).toEqual([
      "systemctl stop openclaw-gateway.service",
      "as openclaw: update restore",
      "systemctl start openclaw-gateway.service",
      "rm /tmp/handoff",
    ]);
  });

  it.each([
    {
      name: "the account's restore gives no status",
      world: { account: { restore: [0, "done\n"] as [number, string] } },
      restoreRuns: true,
    },
    {
      name: "processes remain in the unit's cgroup",
      world: { cgroupEvents: "populated 1\n", account: { restore: ok("restored") } },
      restoreRuns: false,
    },
  ])("leaves the unit stopped when $name", async ({ world, restoreRuns }) => {
    const events = runSettle(await settleScript(), "settle", {
      version: "2026.11.10",
      active: "active",
      ...world,
    });

    expect(events).not.toContain("systemctl start openclaw-gateway.service");
    expect(events.includes("as openclaw: update restore")).toBe(restoreRuns);
  });

  it("starts the previous package when the migration never backed anything up", async () => {
    const events = runSettle(await settleScript(), "settle", {
      version: "2026.11.10",
      active: "active",
      receipt: false,
      account: { restore: [1, ""] },
    });

    expect(events).toContain("systemctl start openclaw-gateway.service");
  });

  it("treats a same-version package with another build as the restored previous one", async () => {
    const events = runSettle(await settleScript(), "settle", {
      version: "2026.11.16",
      buildId: "build-previous",
      active: "active",
      account: { restore: ok("restored") },
    });

    expect(events).toContain("as openclaw: update restore");
    expect(events).not.toContain("as openclaw: update finish");
  });

  it.each([
    { version: "2026.11.10", started: true },
    { version: "2026.11.16", started: false },
  ])(
    "starts a restored unit only on the previous package ($version)",
    async ({ version, started }) => {
      const events = runSettle(await settleScript(), "start", {
        version,
        active: "inactive",
        account: {},
      });

      expect(events.includes("systemctl start openclaw-gateway.service")).toBe(started);
      expect(events.some((event) => event.startsWith("as "))).toBe(false);
    },
  );
});
