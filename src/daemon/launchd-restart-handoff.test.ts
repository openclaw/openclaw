import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";

type SpawnCall = [string, string[], { env: Record<string, string | undefined> }];
const spawnMock = vi.hoisted(() => vi.fn<(...args: SpawnCall) => unknown>());
const unrefMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import {
  scheduleDetachedLaunchdMaintenancePark,
  scheduleDetachedLaunchdRestartHandoff,
} from "./launchd-restart-handoff.js";

const execFileAsync = promisify(execFile);
const defaultEnv = { HOME: "/Users/test", OPENCLAW_PROFILE: "default" };
function schedule(options: Parameters<typeof scheduleDetachedLaunchdRestartHandoff>[0]) {
  return scheduleDetachedLaunchdRestartHandoff({ env: defaultEnv, ...options });
}
function expectReload(
  result: Awaited<ReturnType<typeof executeHandoff>>,
  counts: Record<string, number>,
  code = 0,
) {
  expect(result.exitCode).toBe(code);
  for (const [command, count] of Object.entries(counts)) {
    expect(result.calls.filter((call) => call.startsWith(`${command} `))).toHaveLength(count);
  }
  expect(result.log).toContain(code ? "restart failed" : "restart done");
  expect(result.log).not.toContain(code ? "restart done" : "restart failed");
}

const countCall = (command: string) => `    count_file="$LAUNCHCTL_STUB_DIR/${command}-count"
    count=0
    [ -f "$count_file" ] && count=$(sed -n '1p' "$count_file")
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"`;

const spawnCall = () => spawnMock.mock.calls[0]!;
const stubCommands = (commands: Record<string, string>) =>
  `case "$1" in\n${Object.entries(commands)
    .map(([command, body]) => `  ${command}) ${body} ;;`)
    .join("\n")}\n  *) exit 0 ;;\nesac`;
const countedCommand = (command: string, body: string) => `${countCall(command)}\n${body}`;
const startStub = 'case "$1" in enable|kickstart) exit 0 ;; *) exit 1 ;; esac';

async function executeHandoff(
  mode: "park" | "reload" | "start-after-exit",
  launchctlStub: string,
  systemOwnership: "absent" | "loaded" | "interrupted extraction" = "absent",
) {
  const stubDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "launchd-stub-")));
  try {
    const file = (name: string) => path.join(stubDir, name);
    const writeScript = (name: string, source: string) => {
      fs.writeFileSync(file(name), `#!/bin/sh\n${source}\n`, { mode: 0o755 });
    };
    const home = file("home");
    const stateDir = path.join(home, ".openclaw");
    const systemDaemonsDir = file("LaunchDaemons");
    const handoffEnv = {
      HOME: home,
      OPENCLAW_PROFILE: "default",
      OPENCLAW_STATE_DIR: stateDir,
      BOUNDARY_SERVICE: "synthetic-service",
    };
    vi.stubGlobal("process", {
      ...process,
      env: {
        PATH: `${stubDir}:/usr/bin:/bin`,
        TMPDIR: stubDir,
        BOUNDARY_PARENT: "synthetic-parent",
      },
    });
    fs.mkdirSync(path.join(stateDir, "logs"), { recursive: true });
    fs.mkdirSync(systemDaemonsDir);
    writeScript(
      "launchctl",
      `LAUNCHCTL_CALLS_PATH="$TMPDIR/launchctl.calls"
LAUNCHCTL_STUB_DIR="$TMPDIR"
printf '%s\\n' "$*" >> "$LAUNCHCTL_CALLS_PATH"
printf '%s:%s:%s\\n' "\${BOUNDARY_PARENT+present}" "\${BOUNDARY_SERVICE+present}" "\${OPENCLAW_PROFILE+present}" >> "$TMPDIR/environment.calls"
if [ "$1" = "print" ] && [ "$2" = "system/ai.openclaw.gateway" ]; then
  ${systemOwnership === "loaded" ? "exit 0" : "printf 'Could not find service\\n' >&2; exit 113"}
fi
${launchctlStub}
`,
    );
    writeScript("sleep", "exit 0");
    const parser = file("plutil");
    if (systemOwnership === "interrupted extraction") {
      fs.writeFileSync(
        path.join(systemDaemonsDir, "owner.plist"),
        '<plist version="1.0"><dict><key>Label</key><string>ai.openclaw.gateway</string></dict></plist>',
      );
      writeScript(
        "plutil",
        `for last; do :; done
if [ "$last" != '-' ]; then exit 1; fi
if [ "$1" = '-extract' ]; then kill -TERM "$$"; fi
exec /usr/bin/plutil "$@"
`,
      );
    }

    if (mode === "park") {
      scheduleDetachedLaunchdMaintenancePark({ env: handoffEnv, waitForPid: 0 });
    } else {
      schedule({ env: handoffEnv, mode, waitForPid: 0 });
    }
    const [, args, options] = spawnCall();
    const script = args[1]!
      .replaceAll("/Library/LaunchDaemons", `'${systemDaemonsDir.replaceAll("'", "'\\''")}'`)
      .replaceAll(
        "/usr/bin/plutil",
        systemOwnership === "interrupted extraction" ? parser : "/usr/bin/plutil",
      );

    let exitCode = 0;
    try {
      await execFileAsync(
        "/bin/sh",
        ["-c", script, "handoff-test", "gui/501/test.label", "gui/501", file("test.plist"), "0"],
        { env: options.env },
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code !== "number") {
        throw error;
      }
      exitCode = code;
    }

    const readLines = (name: string) => fs.readFileSync(file(name), "utf8").trim().split("\n");
    expect(new Set(readLines("environment.calls"))).toEqual(new Set(["::"]));
    const calls = readLines("launchctl.calls").filter(
      (call) => call !== "print system/ai.openclaw.gateway",
    );
    const log = fs.readFileSync(path.join(stateDir, "logs", "gateway-restart.log"), "utf8");
    return { calls, exitCode, log };
  } finally {
    vi.unstubAllGlobals();
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  spawnMock.mockReset();
  unrefMock.mockReset();
  spawnMock.mockReturnValue({ pid: 4242, unref: unrefMock, once: vi.fn() });
});

it("waits for the caller pid before kickstarting launchd", () => {
  expect(schedule({ mode: "kickstart", waitForPid: 9876 })).toEqual({
    ok: true,
    value: expect.any(Promise),
  });
  const [, args] = spawnCall();
  expect(args[6]).toBe("9876");
  for (const fragment of [
    'while kill -0 "$wait_pid" >/dev/null 2>&1; do',
    'if launchctl kickstart -k "$service_target"; then',
    'if launchctl bootstrap "$domain" "$plist_path"; then\n    status=0\n  else\n    launchctl kickstart -k "$service_target"',
  ]) {
    expect(args[1]).toContain(fragment);
  }
  expect(unrefMock).toHaveBeenCalledTimes(1);
});

it("kickstarts after exit without replacing a running KeepAlive process", async () => {
  const result = await executeHandoff("start-after-exit", startStub);

  expect(result).toMatchObject({
    exitCode: 0,
    calls: ["enable gui/501/test.label", "kickstart gui/501/test.label"],
  });
  expect(result.log).toContain("restart done");
});

it.for(["loaded", "interrupted extraction"] as const)(
  "refuses detached activation for %s ownership",
  async (scenario, context) => {
    if (scenario === "interrupted extraction" && process.platform !== "darwin") {
      context.skip();
    }
    const result = await executeHandoff("start-after-exit", startStub, scenario);

    expect(result).toMatchObject({ exitCode: 78, calls: [] });
    expect(result.log).toContain("restart blocked");
    expect(result.log).toContain(
      scenario === "loaded"
        ? "loaded system LaunchDaemon system/ai.openclaw.gateway"
        : "could not inspect system LaunchDaemon plist",
    );
  },
);

it("parks the service with bootout after the caller exits", async () => {
  const result = await executeHandoff("park", 'case "$1" in bootout) exit 0 ;; *) exit 1 ;; esac');

  expect(result).toMatchObject({ exitCode: 0, calls: ["bootout gui/501/test.label"] });
  expect(result.log).toContain("service park done");
});

it("executes the generated reload handoff through a delayed launchd stop", async () => {
  const result = await executeHandoff(
    "reload",
    stubCommands({ print: countedCommand("print", '[ "$count" -le 20 ] && exit 0\nexit 113') }),
  );

  expectReload(result, { print: 21, bootstrap: 1 });
  // #110137: the executed handoff must outwait teardown and reload in order.
  expect(spawnCall()[1][1]).toContain('bootout_wait_count="345"');
  expect(result.log).toContain("mode=reload");
  expect(result.calls.slice(0, 2)).toEqual([
    "enable gui/501/test.label",
    "bootout gui/501/test.label",
  ]);
});

it("retries bootstrap when the label disappears between print and kickstart", async () => {
  const result = await executeHandoff(
    "reload",
    stubCommands({
      print: countedCommand("print", '[ "$count" -eq 2 ] && exit 0\nexit 113'),
      bootstrap: countedCommand("bootstrap", '[ "$count" -eq 1 ] && exit 5\nexit 0'),
      kickstart: "exit 113",
    }),
  );

  expectReload(result, { bootstrap: 2, kickstart: 1 });
});

it("reload retry exhaustion exits nonzero instead of reporting a successful restart", async () => {
  // A completed false `if` leaves $? at 0; exhaustion must not report success.
  const result = await executeHandoff(
    "reload",
    'case "$1" in bootstrap) exit 5 ;; print) exit 113 ;; *) exit 0 ;; esac',
  );

  expectReload(result, { bootstrap: 15 }, 5);
});

it("sanitizes restart helper environment overrides before spawning", () => {
  const unsafe = {
    PATH: "/tmp/evil-bin",
    DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    NPM_CONFIG_GLOBALCONFIG: "/tmp/evil-npmrc",
  };
  schedule({ env: { ...defaultEnv, ...unsafe }, mode: "kickstart" });
  const [, args, options] = spawnCall();
  for (const value of Object.values(unsafe)) {
    expect(args[1]).not.toContain(value);
  }
  expect(options.env.PATH).not.toBe(unsafe.PATH);
  expect(options.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
  expect(options.env.NPM_CONFIG_GLOBALCONFIG).toBeUndefined();
  expect(options.env.OPENCLAW_PROFILE).toBeUndefined();
});

it("rejects invalid launchd labels before spawning the helper", () => {
  expect(() => {
    schedule({
      env: {
        HOME: "/Users/test",
        OPENCLAW_LAUNCHD_LABEL: "../evil/\n\u001b[31mlabel\u001b[0m",
      },
      mode: "kickstart",
    });
  }).toThrow("Invalid launchd label: ../evil/label");
  expect(spawnMock).not.toHaveBeenCalled();
});

it.each(["error", "spawn"] as const)("reports the helper %s event", async (event) => {
  const listeners = new Map<string, () => void>();
  spawnMock.mockReturnValue({
    pid: event === "spawn" ? 4242 : undefined,
    unref: unrefMock,
    once: vi.fn((name: string, listener: () => void) => listeners.set(name, listener)),
  });
  const result = scheduleDetachedLaunchdRestartHandoff({ mode: "start-after-exit" });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error);
  }
  listeners.get(event)?.();
  await expect(result.value).resolves.toBe(event === "spawn");
});
