import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
    native.unit = { active: "active", pid: native.startPid };
  },
}));
vi.mock("../../daemon/systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd-exec.js")>()),
  execSystemctl: async () => ({
    code: 0,
    stdout: `ActiveState=${native.unit.active}\nMainPID=${native.unit.pid}\n`,
    stderr: "",
  }),
}));
vi.mock("../../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../process/exec.js")>();
  return {
    ...actual,
    runCommandWithTimeout: async (argv: string[], options: unknown) => {
      if (argv[0] === "/usr/bin/systemd-run") {
        native.scheduled.push(argv);
        return { code: 0, stdout: "", stderr: "" };
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
function installAccount(answers: Record<string, [number, string]>): void {
  accountDir = dirs.make("service-account-steps-");
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

const scheduledPayloads = () =>
  native.scheduled.map((argv) => JSON.parse(argv.at(-1) ?? "null") as Record<string, unknown>);

const ok = (status: string): [number, string] => [0, `${JSON.stringify({ status })}\n`];

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
  root = dirs.make("service-account-release-");
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "index.js"), "setInterval(() => {}, 1000);\n");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.11.16" }),
  );
  // A real process running this release, so its /proc entry identifies the served build.
  const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], { stdio: "ignore" });
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

      expect(result).toMatchObject({ status: "updated", warnings: [] });
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
        mode: "start",
        driverPid: process.ppid,
        root: fs.realpathSync(root),
        candidateVersion: "2026.11.16",
        unit: "openclaw-gateway.service",
      },
    ]);
    // The transient unit's argv carries no environment values, only the handoff path.
    expect(JSON.stringify(native.scheduled)).not.toContain("unit-only-value");
  });

  it("keeps the unit stopped and the backup when the account cannot restore", async () => {
    installAccount({ migrate: [1, ""], restore: [1, ok("restored")[1]] });

    const result = await activate();

    expect(result).toMatchObject({ status: "failed", stateRestored: false });
    expect(result.status === "failed" && result.message).toContain("update backup is kept");
    // Restoring re-confirms the stop first.
    expect(native.events).toEqual(["stop", "stop"]);
    expect(native.scheduled).toEqual([]);
  });

  it("keeps the state and the backup when the unit cannot be confirmed stopped", async () => {
    installAccount({ migrate: ok("migrated"), restore: ok("restored") });
    native.stopIgnored = true;

    const result = await activate();

    expect(result).toMatchObject({ status: "failed", stateRestored: false });
    expect(result.status === "failed" && result.message).toContain("nothing was migrated");
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
