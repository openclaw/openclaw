import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const {
  census,
  directory,
  read,
  readlink,
  realpath,
  stat,
  definitelyDead,
  container,
  darwinCommand,
  windows,
  fixturePath,
} = vi.hoisted(() => ({
  census: vi.fn(),
  directory: vi.fn(),
  read: vi.fn(),
  readlink: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  definitelyDead: vi.fn(),
  container: vi.fn(),
  darwinCommand: vi.fn(),
  windows: vi.fn(),
  fixturePath: (file: string) => file.replaceAll("\\", "/").replace(/^[A-Za-z]:/, ""),
}));
vi.mock("node:child_process", () => ({ spawnSync: census }));
vi.mock("node:fs", () => {
  // All per-case overrides share the same synthetic paths on Unix and Windows hosts.
  const filesystem = {
    readdirSync: directory,
    readFileSync: (file: string, ...args: unknown[]) => read(fixturePath(file), ...args),
    readlinkSync: (file: string) => readlink(fixturePath(file)),
    realpathSync: (file: string) => realpath(fixturePath(file)),
    statSync: (file: string) => stat(fixturePath(file)),
  };
  return { ...filesystem, default: filesystem };
});
vi.mock("../shared/pid-alive.js", () => ({ isPidDefinitelyDead: definitelyDead }));
vi.mock("./container-environment.js", () => ({ isContainerEnvironment: container }));
vi.mock("../process/supervisor/darwin-process-command.js", () => ({
  readDarwinProcessCommand: darwinCommand,
}));
vi.mock("./windows-process-census.js", () => ({ readWindowsProcessCensus: windows }));
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";

const self = process.pid;
const launcher = self + 1;
const peer = self + 2;
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
type Process = {
  ppid: number;
  argv: string[];
  state?: string;
  flags?: number;
  cwd?: string | Error;
  environment?: string;
  uid?: number;
  commandError?: Error;
};
let rows: Map<number, Process>;

beforeEach(() => {
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  mockProcessPlatform("linux");
  rows = new Map([
    [1, { ppid: 0, argv: ["/sbin/init"] }],
    [launcher, { ppid: 1, argv: ["node", "/app/openclaw.mjs", "doctor", "--fix"] }],
    [self, { ppid: launcher, argv: ["openclaw-doctor"] }],
  ]);
  definitelyDead.mockReset().mockReturnValue(false);
  container.mockReset().mockReturnValue(false);
  census.mockReset();
  darwinCommand.mockReset();
  windows.mockReset();
  realpath.mockReset().mockImplementation((file: string) => file);
  stat.mockReset().mockReturnValue({ isDirectory: () => false });
  readlink.mockReset().mockImplementation((file: string) => {
    const pid = Number(/^\/proc\/(\d+)\/cwd$/.exec(file)?.[1]);
    const cwd = rows.get(pid)?.cwd ?? "/app";
    if (cwd instanceof Error) {
      throw cwd;
    }
    return cwd;
  });
  directory.mockReset().mockImplementation(() => Array.from(rows.keys(), String));
  read.mockReset().mockImplementation((file: string) => {
    if (file.endsWith("/package.json")) {
      return JSON.stringify({
        name: file === "/app/package.json" ? "openclaw" : "unrelated-service",
        scripts: { start: "node service.js" },
      });
    }
    const match = /^\/proc\/(\d+)\/(stat|cmdline|environ|status)$/.exec(file);
    const pid = Number(match?.[1]);
    const row = rows.get(pid);
    if (!row) {
      throw Object.assign(new Error("Process disappeared"), { code: "ENOENT" });
    }
    if (match?.[2] === "environ") {
      return row.environment ?? "";
    }
    if (match?.[2] === "status") {
      const uid = row.uid ?? 1000;
      return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
    }
    if (match?.[2] === "cmdline" && row.commandError) {
      throw row.commandError;
    }
    return match?.[2] === "cmdline"
      ? row.argv.join("\0")
      : `${pid} (name ) (with\nparentheses) ${row.state ?? "S"} ${row.ppid} ${self} 0 0 0 ${row.flags ?? 0}`;
  });
});

it.each(["dist/index.js", "/unrelated-app/dist/index.js"])(
  "clears a readable foreign package entrypoint %s",
  (script) => {
    rows.set(peer, { ppid: 1, argv: ["node", script], cwd: "/unrelated-app" });
    expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
  },
);

it("resolves a relative script against the observed OpenClaw installation", () => {
  rows.set(peer, { ppid: 1, argv: ["node", "dist/index.js"], cwd: "/app" });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
});

it("preserves a retained runtime used by an orphaned eval worker", () => {
  rows.set(peer, {
    ppid: 1,
    argv: [
      "node",
      "--eval",
      "import(process.argv[1])",
      "/tmp/openclaw-update-runtime-Ab1234/tree/2f/app/dist/terminal.js",
    ],
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
});

it.each([
  ["node", "dist/index.js"],
  ["bun", "run", "--silent", "start"],
])("preserves the cleanup veto when cwd is unavailable for %j", (...argv) => {
  rows.set(peer, { ppid: 1, argv });
  const inspect = readlink.getMockImplementation()!;
  readlink.mockImplementation((file: string) => {
    if (file === `/proc/${peer}/cwd`) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return inspect(file);
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({
    error: expect.stringContaining(
      `Could not classify PID ${peer}: working directory is unavailable`,
    ),
  });
});

it.each([
  ["bun", "run", "start"],
  ["bun", "start"],
  ["bun", "--loader", ".js:ts", "service.js"],
  ["bun", "run", "--silent", "start"],
  ["bun", "--silent", "run", "start"],
  ["bun", "--foreign-runtime-option", "run", "start"],
  ["bun", "--silent", "--title", "worker", "run", "start"],
  ["tsx", "--foreign-runtime-option", "watch", "service.js"],
  ["node", "--foreign-runtime-option", "service.js"],
  ["node", "--max-semi-space-size=16", "service.js"],
  ["node", "--test-reporter=spec", "--test", "service.js"],
  ["node", "--test-reporter", "dot", "--test", "service.js"],
  ["node", "--test-reporter=tap", "--test", "service.js"],
  ["tsx", "--test-reporter", "spec", "--test", "service.js"],
])("ignores unfamiliar readable foreign argv %j", (...argv) => {
  rows.set(peer, { ppid: 1, argv, cwd: "/unrelated-app" });
  realpath.mockImplementation((file: string) => {
    if (file !== "/unrelated-app/service.js") {
      throw Object.assign(new Error("script does not exist"), { code: "ENOENT" });
    }
    return file;
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
});

it("uses a declared Bun task before a same-named OpenClaw file", () => {
  rows.set(peer, { ppid: 1, argv: ["bun", "run", "start"], cwd: "/unrelated-app" });
  realpath.mockReturnValue("/app/openclaw.mjs");
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
});

it.each([
  ["/app/dist/index.js", "denied"],
  ["/app/dist/index.js", "missing"],
  ["/app/dist/index.js", "malformed"],
  ["/app/dist/index.js", "unnamed"],
  ["/app/dist/index.js", "invalid-name"],
  ["/app/service.js", "missing"],
])("vetoes absolute entrypoint %s with %s package identity", (script, failure) => {
  rows.set(peer, { ppid: 1, argv: ["node", script] });
  const inspect = read.getMockImplementation()!;
  read.mockImplementation((file: string) => {
    if (!file.endsWith("/package.json")) {
      return inspect(file);
    }
    if (failure === "denied" || failure === "missing") {
      throw Object.assign(new Error("unreadable manifest"), {
        code: failure === "denied" ? "EACCES" : "ENOENT",
      });
    }
    return failure === "malformed"
      ? "{"
      : JSON.stringify(failure === "unnamed" ? {} : { name: 42 });
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({
    error: expect.stringContaining("package identity"),
  });
});

it.each(["script", "service-marker", "module-package", "directory-package"])(
  "vetoes unreadable %s evidence",
  (source) => {
    rows.set(peer, {
      ppid: 1,
      argv:
        source === "directory-package"
          ? ["node", "--require=/app", "/unrelated-app/dist/index.js"]
          : source === "module-package"
            ? ["node", "--require=/app/dist/index.js", "/unrelated-app/dist/index.js"]
            : ["node", "/unrelated-app/dist/index.js"],
      cwd: "/unrelated-app",
    });
    if (source === "directory-package") {
      stat.mockImplementation((file: string) => ({ isDirectory: () => file === "/app" }));
    }
    if (source === "script") {
      realpath.mockImplementation((file: string) => {
        if (file === "/unrelated-app/dist/index.js") {
          throw Object.assign(new Error("script disappeared"), { code: "ENOENT" });
        }
        return file;
      });
    } else {
      const inspect = read.getMockImplementation()!;
      read.mockImplementation((file: string) => {
        if (file === (source.endsWith("package") ? "/app/package.json" : `/proc/${peer}/environ`)) {
          throw Object.assign(new Error("inspection failed"), {
            code: source === "directory-package" ? "ENOENT" : "EACCES",
          });
        }
        return inspect(file);
      });
    }
    expect(inspectOtherOpenClawProcesses()).toHaveProperty("error");
  },
);

it.each([
  ["bun", "run", "--silent", "bridge"],
  ["bun", "--silent", "run", "bridge"],
  ["bun", "run", "--silent", "run"],
  ["bun", "--silent", "service.js", "run"],
  ["bun", "--silent", "--", "run"],
  ["tsx", "--foreign-runtime-option", "watch", "watch"],
])("recognizes an extensionless alias without consuming a subcommand twice: %j", (...argv) => {
  rows.set(peer, { ppid: 1, argv, cwd: "/unrelated-app" });
  realpath.mockImplementation((file: string) =>
    ["/unrelated-app/bridge", "/unrelated-app/run", "/unrelated-app/watch"].includes(file)
      ? "/app/openclaw.mjs"
      : file,
  );
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
});

it("retains a directory module loaded before unfamiliar runtime options", () => {
  rows.set(peer, {
    ppid: 1,
    argv: ["node", "--require=/app", "--future-option", "/unrelated-app/service.js"],
    cwd: "/unrelated-app",
  });
  stat.mockImplementation((file: string) => ({ isDirectory: () => file === "/app" }));
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
});

it.each([
  ["node", "--require", "preload", "/unrelated-app/service.js"],
  ["node", "--import=source-map-support/register", "/unrelated-app/service.js"],
])("does not mistake a bare module reference for a cwd-relative file %j", (...argv) => {
  rows.set(peer, { ppid: 1, argv, cwd: "/unrelated-app" });
  expect(inspectOtherOpenClawProcesses()).toEqual({
    error: expect.stringContaining("runtime module package identity is unavailable"),
  });
});

it.each([
  ["--test-reporter", "/app/reporter.js", "holder"],
  ["--test-reporter", pathToFileURL(path.resolve("/app/reporter.js")).href, "holder"],
  ["--test-reporter", "reporter/register", "unresolved"],
  ["--test-reporter", "reporter", "unresolved"],
  ["--test-global-setup", "setup", "unresolved"],
  ["--foreign-runtime-option", "reporter", "unresolved"],
  ["--foreign-runtime-option", "/app/reporter.js", "holder"],
])("inspects potential module option %s=%s", (option, value, custody) => {
  rows.set(peer, {
    ppid: 1,
    argv: ["node", `${option}=${value}`, "--test", "/unrelated-app/service.js"],
    cwd: "/unrelated-app",
  });
  expect(inspectOtherOpenClawProcesses()).toEqual(
    custody === "unresolved"
      ? { error: expect.stringContaining("package identity is unavailable") }
      : { pids: [peer] },
  );
});

it.each([
  "/tmp/openclaw-plugin-build-abc123/package/worker.js",
  "/tmp/openclaw-update-runtime-Ab1234/tree/plugin/worker.js",
])("preserves an artifact reached through a script alias: %s", (target) => {
  rows.set(peer, { ppid: 1, argv: ["node", "/unrelated-app/alias.js"], cwd: "/unrelated-app" });
  realpath.mockImplementation((file: string) =>
    file === "/unrelated-app/alias.js" ? target : file,
  );
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
});

it.each([
  "/tmp/openclaw-plugin-build-abc123/package",
  "/tmp/openclaw-model-catalog-abc123",
  "/tmp/openclaw-update-runtime-Ab1234/tree/2f/app",
])("preserves an unfamiliar runtime with custody in cwd %s", (cwd) => {
  for (const argv of [
    ["bun", "run", "--silent", "start"],
    ["node", "/vendor/worker.js"],
  ]) {
    rows.set(peer, { ppid: 1, argv, cwd });
    expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
  }
});

it("recognizes an owned service marker without guessing from its script name", () => {
  rows.set(peer, {
    ppid: 1,
    argv: ["node", "/vendor/renamed.js"],
    environment: "OPENCLAW_SERVICE_MARKER=openclaw\0",
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (getuidDescriptor) {
    Object.defineProperty(process, "getuid", getuidDescriptor);
  } else {
    Reflect.deleteProperty(process, "getuid");
  }
});

it("exempts self and its verified Doctor launcher, but not a same-group peer or child", () => {
  rows.set(peer, { ppid: 1, argv: ["openclaw", "doctor"] });
  rows.set(peer + 1, { ppid: self, argv: ["openclaw-models"] });
  rows.set(peer + 2, { ppid: 1, argv: ["python", "worker.py"] });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer, peer + 1] });
});

it.each([
  ["openclaw-gateway"],
  ["openclaw-agent"],
  ["node", "/app/scripts/run-node.mjs", "models", "status"],
  ["node", "/app/dist/entry.js", "agent"],
  ["node", "/app/src/agents/prepared-model-catalog.worker.ts"],
  ["node", "/app/dist/agents/prepared-model-catalog.worker.js"],
  ["/tmp/openclaw-plugin-build-abc123/node_modules/vendor/codex"],
  ["/usr/bin/node", "/tmp/openclaw-plugin-build-abc123/node_modules/tool/cli.js"],
  ["node", "--import=/tmp/openclaw-plugin-build-abc123/loader.js", "app.js"],
  ["bun", "run", "--silent", "/tmp/openclaw-plugin-build-abc123/script.js"],
  ["node", "--foreign-runtime-option", "/tmp/openclaw-update-runtime-Ab1234/script.js"],
  ["bun", "run", "--silent", "start", "--config=openclaw-plugin-build-abc123/config.json"],
  ["node", "--foreign-runtime-option", "--runtime=openclaw-update-runtime-Ab1234/script.js"],
  ["bun", "run", "--silent", "/app/openclaw.mjs"],
  ["bun", "run", "--silent", "/app/dist/index.js"],
  ["node", "-r/app/dist/index.js", "/unrelated-app/service.js"],
  ["node", "openclaw-plugin-build-abc123/script.js"],
  ["node", "/tmp/openclaw-model-catalog-abc123/worker.cjs"],
])("recognizes live command identity %j", (...argv) => {
  rows.set(peer, { ppid: 1, argv });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
});

it.each([
  ["openclaw-doctor"],
  ["openclaw-update"],
  ["openclaw", "agent", "--message", "doctor"],
  ["openclaw", "agent", "--message", "openclaw", "doctor"],
])("does not exempt an unverified ancestor %j", (...argv) => {
  rows.set(launcher, { ppid: 1, argv });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [launcher] });
});

it("recognizes the current Doctor launcher with root options and skips kernel threads", () => {
  rows.set(launcher, {
    ppid: 1,
    argv: ["node", "/app/openclaw.mjs", "--profile", "work", "doctor", "--fix"],
  });
  rows.set(peer, { ppid: 1, argv: [], flags: 0x0020_0000 });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
});

it.each(["missing self", "missing ancestor", "unreadable command", "failed enumeration"])(
  "does not authorize cleanup with %s",
  (failure) => {
    if (failure === "missing self") {
      rows.delete(self);
    }
    if (failure === "missing ancestor") {
      rows.delete(launcher);
    }
    if (failure === "unreadable command") {
      const inspect = read.getMockImplementation()!;
      read.mockImplementation((file: string) => {
        if (file.endsWith("/cmdline")) {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return inspect(file);
      });
    }
    if (failure === "failed enumeration") {
      directory.mockImplementation(() => {
        throw new Error("denied");
      });
    }
    expect(inspectOtherOpenClawProcesses()).toHaveProperty("error");
  },
);

it("does not mistake an unidentified userspace process for a kernel thread", () => {
  rows.set(peer, { ppid: 1, argv: [] });
  expect(inspectOtherOpenClawProcesses()).toHaveProperty("error");
});

it("does not treat a container's process namespace as complete host visibility", () => {
  container.mockReturnValue(true);
  expect(inspectOtherOpenClawProcesses()).toEqual({
    error: expect.stringContaining("Host process visibility"),
  });
  expect(directory).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves unidentified live threads of a zombie leader (dead=%s)",
  (dead) => {
    rows.set(peer, { ppid: 1, argv: [], state: "Z" });
    definitelyDead.mockReturnValue(dead);
    const result = inspectOtherOpenClawProcesses();
    if (dead) {
      expect(result).toEqual({ pids: [] });
    } else {
      expect(result).toHaveProperty("error");
    }
  },
);

it("uses native Darwin arguments and explicit foreign system-service facts", () => {
  mockProcessPlatform("darwin");
  const foreignUid = (process.getuid?.() ?? 501) + 1;
  rows.set(peer, { ppid: 1, argv: ["node", "/app with spaces/openclaw.mjs", "status"] });
  census.mockImplementation((command: string) => ({
    status: 0,
    stdout: command.endsWith("lsof")
      ? [...rows].map(([pid, row]) => `p${pid}\0n${row.cwd ?? "/foreign"}\0\n`).join("")
      : [...rows].map(([pid, row]) => `${pid} ${self} S ${row.ppid} 501`).join("\n"),
  }));
  darwinCommand.mockImplementation((pid: number) =>
    pid === 1
      ? { argvUnavailable: true, executable: "/sbin/launchd", uid: foreignUid }
      : { argv: rows.get(pid)!.argv },
  );
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
  rows.set(peer, { ppid: 1, argv: ["node", "/unrelated-app/dist/index.js"] });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
  rows.set(peer, { ppid: 1, argv: ["node", "/app/dist/index.js"] });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
  rows.delete(peer);
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
  rows.get(1)!.cwd = "/tmp/openclaw-plugin-build-abc123/package";
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [1] });
  rows.get(1)!.cwd = undefined;
  darwinCommand.mockImplementation(() => {
    throw new Error("unreadable live process");
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({
    error: expect.stringContaining("unreadable live process"),
  });
});

it("does not authorize cleanup without exact argv inspection on win32", () => {
  mockProcessPlatform("win32");
  expect(inspectOtherOpenClawProcesses()).toEqual({
    error: expect.stringContaining("Exact process command census is unavailable on win32"),
  });
  expect(census).not.toHaveBeenCalled();
});

it("retains Darwin cwd holders from one partial batch without trusting other PID records", () => {
  mockProcessPlatform("darwin");
  rows.set(peer, { ppid: 1, argv: ["node", "/vendor/worker.js"] });
  rows.set(peer + 1, { ppid: 1, argv: ["bun", "run", "--silent", "start"] });
  census.mockImplementation((command: string) =>
    command.endsWith("lsof")
      ? {
          status: 1,
          stdout: `p1\0n/\0\np${peer}\0fcwd\0n/tmp/openclaw-plugin-build-abc123/package\0\np999999999\0n/tmp/openclaw-update-runtime-Ab1234\0\np${peer + 1}\0n/tmp/unrelated\0`,
        }
      : {
          status: 0,
          stdout: [...rows].map(([pid, row]) => `${pid} ${self} S ${row.ppid} 501`).join("\n"),
        },
  );
  darwinCommand.mockImplementation((pid: number) => ({ argv: rows.get(pid)!.argv }));
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
  expect(census.mock.calls.filter(([command]) => command.endsWith("lsof"))).toHaveLength(1);
});

it.each(["dist/index.js", "/unrelated-app/dist/index.js"])(
  "vetoes a cwd batch timeout for %s",
  (script) => {
    mockProcessPlatform("darwin");
    rows.set(peer, { ppid: 1, argv: ["node", script] });
    census.mockImplementation((command: string) =>
      command.endsWith("lsof")
        ? {
            status: null,
            error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
            stdout: "",
          }
        : {
            status: 0,
            stdout: [...rows].map(([pid, row]) => `${pid} ${self} S ${row.ppid} 501`).join("\n"),
          },
    );
    darwinCommand.mockImplementation((pid: number) => ({ argv: rows.get(pid)!.argv }));
    expect(inspectOtherOpenClawProcesses()).toEqual({
      error: expect.stringContaining("working directory is unavailable"),
    });
  },
);

it("vetoes a partial cwd batch with a missing foreign process record", () => {
  mockProcessPlatform("darwin");
  rows.set(peer, { ppid: 1, argv: ["node", "/unrelated-app/dist/index.js"] });
  census.mockImplementation((command: string) =>
    command.endsWith("lsof")
      ? { status: 1, stdout: `p1\0n/\0` }
      : {
          status: 0,
          stdout: [...rows].map(([pid, row]) => `${pid} ${self} S ${row.ppid} 501`).join("\n"),
        },
  );
  darwinCommand.mockImplementation((pid: number) => ({ argv: rows.get(pid)!.argv }));
  expect(inspectOtherOpenClawProcesses()).toEqual({
    error: expect.stringContaining("working directory is unavailable"),
  });
});

const references = { runId: "update-run-123", artifactPaths: ["/tmp/retained runtime"] };
const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });

it("finds orphaned handoff references while excluding only its verified updater launcher", () => {
  rows.set(launcher, {
    ppid: 1,
    argv: ["node", "/app/openclaw.mjs", "update", "repair", references.runId],
  });
  rows.set(peer, { ppid: 1, argv: ["node", "--run-id=update-run-123"] });
  rows.set(peer + 1, { ppid: 1, argv: ["node", "worker.js"], cwd: "/tmp/retained runtime/tree" });
  rows.set(peer + 2, { ppid: 1, argv: ["node", "/tmp/retained runtime/tree/worker.js"] });
  rows.set(peer + 3, {
    ppid: 1,
    argv: [
      "node",
      "update-run-1234",
      "/tmp/retained runtime-other",
      "/tmp/retained runtime.old/worker.js",
    ],
  });
  rows.set(peer + 4, {
    ppid: 1,
    argv: ["node", "other-update-run-123", "/different/tmp/retained runtime"],
  });
  rows.set(peer + 5, {
    ppid: 1,
    argv: ["node", "--eval", 'import("file:///tmp/retained%20runtime/tree/worker.js")'],
  });
  expect(inspectOtherOpenClawProcesses(references)).toEqual({
    matchingPids: [peer, peer + 1, peer + 2, peer + 5],
    unverifiedPids: [],
  });
  rows.set(launcher, { ppid: 1, argv: ["openclaw-update", references.runId] });
  expect(inspectOtherOpenClawProcesses(references).matchingPids).toContain(launcher);
});

it.each(["linux", "darwin"] as const)(
  "checks readable handoff references before excluding opaque foreign %s processes",
  (platform) => {
    mockProcessPlatform(platform);
    rows.set(peer, { ppid: 1, argv: ["node", "worker.js"], cwd: denied() });
    rows.set(peer + 1, { ppid: 1, argv: [], uid: 2000, commandError: denied(), cwd: denied() });
    rows.set(peer + 2, {
      ppid: 1,
      argv: [],
      uid: 2000,
      commandError: denied(),
      cwd: "/tmp/retained runtime/tree",
    });
    rows.set(peer + 3, { ppid: 1, argv: ["node", references.runId], uid: 2000, cwd: denied() });
    if (platform === "darwin") {
      census.mockImplementation((command: string, args: string[]) => {
        if (command === "/bin/ps") {
          return {
            status: 0,
            stdout: [...rows]
              .map(([pid, row]) => `${pid} ${self} S ${row.ppid} ${row.uid ?? 1000}`)
              .join("\n"),
          };
        }
        const stdout = args[args.indexOf("-p") + 1]!.split(",")
          .map(Number)
          .flatMap((pid) => {
            const cwd = rows.get(pid)?.cwd ?? "/app";
            return cwd instanceof Error ? [] : [`p${pid}\0n${cwd}\0`];
          })
          .join("");
        return { status: 1, stdout };
      });
      darwinCommand.mockImplementation((pid: number, uid: number) =>
        rows.get(pid)?.commandError
          ? { argvUnavailable: true, uid }
          : { argv: rows.get(pid)!.argv },
      );
    }
    expect(inspectOtherOpenClawProcesses(references)).toEqual({
      matchingPids: [peer + 2, peer + 3],
      unverifiedPids: [peer],
    });
  },
);

it("names an unreadable same-user PID without exposing its process data", () => {
  rows.set(peer, {
    ppid: 1,
    argv: [],
    commandError: Object.assign(new Error("private-process-value"), { code: "EACCES" }),
  });
  const observed = inspectOtherOpenClawProcesses(references);
  expect(observed.unverifiedPids).toEqual([peer]);
  expect(observed.error).toContain("census is incomplete");
  expect(JSON.stringify(observed)).not.toContain("private-process-value");
});

it.each([
  ["2000\t1000\t2000\t2000", false],
  ["2000\t2000\t1000\t2000", false],
  ["2000\t2000\t2000\t1000", false],
  ["2000\t0\t2000\t0", true],
] as const)(
  "checks every Linux credential UID before excluding unreadable work (%s)",
  (uids, foreign) => {
    rows.set(peer, { ppid: 1, argv: ["node", "worker.js"], uid: 2000, cwd: denied() });
    const readFile = read.getMockImplementation()!;
    read.mockImplementation((file: string) =>
      file === `/proc/${peer}/status` ? `Uid:\t${uids}\n` : readFile(file),
    );
    expect(inspectOtherOpenClawProcesses(references)).toEqual({
      matchingPids: [],
      unverifiedPids: foreign ? [] : [peer],
    });
  },
);

it.each(["container", "missing self", "deadline"])(
  "holds handoff recovery with %s observations",
  (failure) => {
    if (failure === "container") {
      container.mockReturnValue(true);
    } else if (failure === "missing self") {
      rows.delete(self);
    } else {
      vi.spyOn(Date, "now").mockReturnValueOnce(1).mockReturnValue(20_000);
    }
    expect(inspectOtherOpenClawProcesses(references).error).toBeDefined();
  },
);

it.each(
  [100, 200, 300].flatMap((parentStart) =>
    [
      "openclaw update repair --run-id=update-run-123",
      String.raw`node --title "" "C:\app\openclaw.mjs" update repair --run-id=update-run-123`,
      String.raw`"C:\Program Files\node.exe" --title "C:\Team Notes\\" "C:\app\openclaw.mjs" update repair --run-id=update-run-123`,
    ].map((commandLine) => ({ parentStart, commandLine })),
  ),
)(
  "excludes a Windows updater ancestor only with an earlier start ($parentStart, $commandLine)",
  ({ parentStart, commandLine }) => {
    mockProcessPlatform("win32");
    windows.mockReturnValue([
      {
        pid: self,
        parentPid: launcher,
        startIdentity: "200",
        commandLine: "openclaw update repair",
        cwd: "C:\\app",
      },
      {
        pid: launcher,
        parentPid: 0,
        startIdentity: String(parentStart),
        commandLine,
        cwd: "C:\\app",
      },
      {
        pid: peer,
        parentPid: 0,
        commandLine: 'node "C:\\Temp\\Retained Runtime\\tree\\worker.js"',
        cwd: "C:\\app",
      },
      {
        pid: peer + 1,
        parentPid: 0,
        commandLine: "node worker.js",
        cwd: "c:/temp/retained runtime/tree",
      },
      { pid: peer + 2 },
      { pid: peer + 3, foreignOwner: true },
      { pid: peer + 4, foreignOwner: true, commandLine: "node --id=update-run-123" },
      {
        pid: peer + 5,
        parentPid: 0,
        commandLine: "node worker.js",
        cwd: "\\\\?\\C:\\Temp\\Retained Runtime\\tree",
      },
      {
        pid: peer + 6,
        parentPid: 0,
        commandLine: 'node "file:///C:/Temp/Retained%20Runtime/tree/worker.js"',
        cwd: "C:\\app",
      },
      { pid: peer + 7, parentPid: 0, commandLine: '"unterminated.exe', cwd: "C:\\app" },
      { pid: peer + 8, parentPid: 0, commandLine: "node\0 --id=update-run-123", cwd: "C:\\app" },
      { pid: peer + 9, parentPid: 0, commandLine: "", cwd: "C:\\app" },
    ]);
    expect(
      inspectOtherOpenClawProcesses({
        ...references,
        artifactPaths: ["c:\\temp\\retained runtime"],
      }),
    ).toEqual({
      matchingPids: [
        ...(parentStart >= 200 ? [launcher] : []),
        peer,
        peer + 1,
        peer + 4,
        peer + 5,
        peer + 6,
        peer + 8,
      ],
      unverifiedPids: [peer + 2, peer + 7, peer + 9],
      error: "Retry update repair as Administrator using the same Windows account.",
    });
  },
);

it.each(["denied", "empty"])("preserves Doctor's refusal for foreign Linux %s argv", (kind) => {
  rows.set(peer, {
    ppid: 1,
    uid: 2000,
    argv: [],
    ...(kind === "denied" ? { commandError: denied() } : {}),
  });
  expect(inspectOtherOpenClawProcesses()).toHaveProperty("error");
});

it("retains known matching PIDs when later inspection exhausts the census budget", () => {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  rows.set(peer, { ppid: 1, argv: ["node", references.runId] });
  rows.set(peer + 1, { ppid: 1, argv: ["node", "worker.js"] });
  rows.set(peer + 2, { ppid: 1, argv: ["node", "worker.js"] });
  definitelyDead.mockImplementation((pid: number) => {
    if (pid === peer + 1) {
      now = 20_000;
    }
    return false;
  });
  expect(inspectOtherOpenClawProcesses(references)).toMatchObject({
    matchingPids: [peer],
    error: expect.stringContaining("census is incomplete"),
  });
});
