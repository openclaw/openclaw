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
}));
vi.mock("node:child_process", () => ({ spawnSync: census }));
vi.mock("node:fs", () => ({
  readdirSync: directory,
  readFileSync: read,
  readlinkSync: readlink,
  realpathSync: realpath,
  default: { readFileSync: read, realpathSync: realpath, readlinkSync: readlink, statSync: stat },
}));
vi.mock("../shared/pid-alive.js", () => ({ isPidDefinitelyDead: definitelyDead }));
vi.mock("./container-environment.js", () => ({ isContainerEnvironment: container }));
vi.mock("../process/supervisor/darwin-process-command.js", () => ({
  readDarwinProcessCommand: darwinCommand,
}));
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";

const self = process.pid;
const launcher = self + 1;
const peer = self + 2;
type Process = {
  ppid: number;
  argv: string[];
  state?: string;
  flags?: number;
  cwd?: string;
  environment?: string;
};
let rows: Map<number, Process>;

beforeEach(() => {
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
  realpath.mockReset().mockImplementation((file: string) => file);
  stat.mockReset().mockReturnValue({ isDirectory: () => false });
  readlink.mockReset().mockImplementation((file: string) => {
    const pid = Number(/^\/proc\/(\d+)\/cwd$/.exec(file)?.[1]);
    return rows.get(pid)?.cwd ?? "/app";
  });
  directory.mockReset().mockImplementation(() => Array.from(rows.keys(), String));
  read.mockReset().mockImplementation((file: string) => {
    if (file.endsWith("/package.json")) {
      return JSON.stringify({
        name: file === "/app/package.json" ? "openclaw" : "unrelated-service",
        scripts: { start: "node service.js" },
      });
    }
    const match = /^\/proc\/(\d+)\/(stat|cmdline|environ)$/.exec(file);
    const pid = Number(match?.[1]);
    const row = rows.get(pid);
    if (!row) {
      throw Object.assign(new Error("Process disappeared"), { code: "ENOENT" });
    }
    if (match?.[2] === "environ") {
      return row.environment ?? "";
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
  ["--test-reporter", "file:///app/reporter.js", "holder"],
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
afterEach(() => vi.restoreAllMocks());

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
