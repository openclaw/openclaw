import path from "node:path";
import { pathToFileURL } from "node:url";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
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
  nativeDarwinCensus,
  rosetta,
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
  nativeDarwinCensus: vi.fn(),
  rosetta: vi.fn(),
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
// mock-isolation: the real detector reads and caches the test host's CPU brand.
vi.mock("../shared/rosetta-translation.js", () => ({ isRosettaTranslatedProcess: rosetta }));
// mock-isolation: Enumerate only the synthetic process table.
vi.mock("../process/darwin-process-inspection.js", () => ({
  readDarwinProcessCensus: nativeDarwinCensus,
}));
vi.mock("../process/supervisor/darwin-process-command.js", () => ({
  readDarwinProcessCommand: darwinCommand,
}));
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";

const self = process.pid;
const launcher = self + 1;
const peer = self + 2;
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
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
  // This synthetic kernel exercises the Node ps contract, including on Bun hosts.
  Object.defineProperty(process.versions, "bun", { configurable: true, value: undefined });
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  mockProcessPlatform("linux");
  rows = new Map([
    [1, { ppid: 0, argv: ["/sbin/init"] }],
    [launcher, { ppid: 1, argv: ["fixture-wrapper"] }],
    [self, { ppid: launcher, argv: ["openclaw-doctor"] }],
  ]);
  definitelyDead.mockReset().mockReturnValue(false);
  container.mockReset().mockReturnValue(false);
  census.mockReset();
  darwinCommand.mockReset();
  nativeDarwinCensus.mockReset().mockImplementation(() =>
    [...rows].map(([pid, row]) => ({
      pid,
      ppid: row.ppid,
      pgid: self,
      state: row.state ?? "S",
      owner: row.uid === undefined || row.uid === 1000 ? "same" : "different",
    })),
  );
  rosetta.mockReset().mockReturnValue(false);
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

type CustodyCase = [
  argv: string[],
  facts: Partial<Omit<Process, "argv" | "ppid">>,
  holder: boolean,
];
const custodyCases: CustodyCase[] = [
  [["/lib/systemd/systemd", "--user", "--deserialize=x"], { cwd: new Error("denied") }, false],
  [["node", "dist/index.js"], { cwd: "/unrelated-app" }, false],
  [["node", "/unrelated-app/dist/index.js"], { cwd: "/unrelated-app" }, false],
  [["node", "dist/index.js"], { cwd: "/app" }, true],
  [
    [
      "node",
      "--eval",
      "import(process.argv[1])",
      "/tmp/openclaw-update-runtime-Ab1234/tree/2f/app/dist/terminal.js",
    ],
    {},
    true,
  ],
  [["bun", "run", "--silent", "start"], { cwd: "/tmp/openclaw-plugin-build-abc123/package" }, true],
  [["node", "/vendor/worker.js"], { cwd: "/tmp/openclaw-plugin-build-abc123/package" }, true],
  [["node", "/vendor/renamed.js"], { environment: "OPENCLAW_SERVICE_MARKER=openclaw\0" }, true],
  ...[
    ["openclaw-gateway"],
    ["node", "/app/src/agents/prepared-model-catalog.worker.ts"],
    ["/tmp/openclaw-plugin-build-abc123/node_modules/vendor/codex"],
    ["bun", "run", "--silent", "start", "--config=openclaw-plugin-build-abc123/config.json"],
    ["bun", "run", "--silent", "/app/dist/index.js"],
    ["node", "-r/app/dist/index.js", "/unrelated-app/service.js"],
    ["node", "/tmp/openclaw-model-catalog-abc123/worker.cjs"],
  ].map((argv): CustodyCase => [argv, {}, true]),
];
it.each(custodyCases)("classifies artifact custody of %j with %j", (argv, facts, holder) => {
  rows.set(peer, { ppid: 1, argv, ...facts });
  expect(inspectOtherOpenClawProcesses()).toMatchObject({ pids: holder ? [peer] : [] });
});

const foreignArgvs = [
  ["bun", "start"],
  ["bun", "--loader", ".js:ts", "service.js"],
  ["bun", "run", "--silent", "start"],
  ["bun", "--silent", "--title", "worker", "run", "start"],
  ["tsx", "--foreign-runtime-option", "watch", "service.js"],
  ["node", "--foreign-runtime-option", "service.js"],
  ["node", "--max-semi-space-size=16", "service.js"],
  ["node", "--max-semi-space-size", "16", "service.js"],
  ["node", "--test-reporter=spec", "--test", "service.js"],
  ["node", "--test-reporter", "dot", "--test", "service.js"],
];

it.each([
  ["node", "/standalone/server.mjs"],
  ["node", "/standalone/dist/index.js"],
  ["node", "-e", "setInterval(() => {}, 1e9)"],
  ["node", "-p", "1"],
  ["node"],
  ["node", "-"],
])("finishes the census for manifest-free %j without losing a later holder", (...argv) => {
  rows.set(peer, { ppid: 1, argv, cwd: "/standalone" });
  rows.set(peer + 1, { ppid: 1, argv: ["node", "/app/dist/index.js"] });
  const inspect = read.getMockImplementation()!;
  read.mockImplementation((file: string) => {
    if (file.endsWith("/package.json") && file !== "/app/package.json") {
      throw Object.assign(new Error("no manifest"), { code: "ENOENT" });
    }
    return inspect(file);
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer + 1] });
  rows.delete(peer + 1);
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
});

it.each([
  ["node", "worker.js"],
  ["/usr/bin/node", "-e", "1"],
])("retains unavailable cwd for %j without losing scoped holders", (...argv) => {
  const held = "/tmp/openclaw-update-runtime-Held01";
  const free = "/tmp/openclaw-update-runtime-Free01";
  rows.set(peer, { ppid: 1, argv, cwd: denied() });
  rows.set(peer + 1, { ppid: 1, argv: ["node", `${held}/worker.js`] });
  for (const [runtime, pids] of [
    [undefined, [peer, peer + 1]],
    [free, [peer]],
    [held, [peer, peer + 1]],
  ] as const) {
    expect(inspectOtherOpenClawProcesses(runtime)).toEqual({
      pids,
      warnings: [expect.stringContaining(`PID ${peer}: working directory is unavailable`)],
    });
  }
  rows.delete(peer);
  expect(inspectOtherOpenClawProcesses(free)).toEqual({ pids: [] });
});

it.each(["relative", "alias", "cwd-and-preload"])(
  "scopes all resolved runtime references (%s)",
  (source) => {
    const held = "/tmp/openclaw-update-runtime-Held01";
    const other = "/tmp/openclaw-update-runtime-Free01";
    const alias = "/tmp/openclaw-update-runtime-Alias1/worker.js";
    realpath.mockImplementation((file: string) => {
      if (file.includes("--require=")) {
        throw Object.assign(new Error("option is not a path"), { code: "ENOENT" });
      }
      return source === "alias" && file === alias ? `${held}/worker.js` : file;
    });
    rows.set(peer, {
      ppid: 1,
      argv:
        source === "relative"
          ? ["node", "../openclaw-update-runtime-Held01/worker.js"]
          : source === "alias"
            ? ["node", alias]
            : ["node", `--require=${held}/preload.js`, `${held}/worker.js`],
      cwd: source === "cwd-and-preload" ? other : "/tmp/launch",
    });
    expect(inspectOtherOpenClawProcesses(held)).toEqual({ pids: [peer] });
    expect(inspectOtherOpenClawProcesses(other)).toEqual({
      pids: source === "cwd-and-preload" ? [peer] : [],
    });
    expect(inspectOtherOpenClawProcesses("/tmp/openclaw-update-runtime-None01")).toEqual({
      pids: [],
    });
  },
);

it("preserves unresolved artifact evidence when cwd proves foreign", () => {
  rows.set(peer, {
    ppid: 1,
    cwd: "/unrelated-app",
    argv: [
      "node",
      "--future-option",
      "-r",
      "/unrelated-app/preload.js",
      "-e",
      "require('/tmp/openclaw-update-runtime-Held01/worker.js')",
    ],
  });
  realpath.mockImplementation((file: string) => {
    if (file.includes("require(")) {
      throw Object.assign(new Error("not a path"), { code: "ENOENT" });
    }
    return file;
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({
    pids: [peer],
    warnings: [expect.stringContaining("could not resolve script")],
  });
});

it.each([
  ["/app/dist/index.js", "denied"],
  ["/app/dist/index.js", "unnamed"],
  ["/app/service.js", "missing"],
])(
  "distinguishes absent from unreadable entrypoint %s package evidence (%s)",
  (script, failure) => {
    rows.set(peer, { ppid: 1, argv: ["node", script] });
    const inspect = read.getMockImplementation()!;
    read.mockImplementation((file: string) => {
      if (!file.endsWith("/package.json")) {
        return inspect(file);
      }
      if (failure === "unnamed") {
        return JSON.stringify({});
      }
      throw Object.assign(new Error("unreadable manifest"), {
        code: failure === "denied" ? "EACCES" : "ENOENT",
      });
    });
    expect(inspectOtherOpenClawProcesses()).toEqual(
      failure === "missing"
        ? { pids: [] }
        : {
            pids: [peer],
            warnings: [expect.stringContaining(`PID ${peer}:`)],
          },
    );
  },
);

it.each(["script", "service-marker", "module-package", "directory-package"])(
  "retains uncertain runtime custody with unreadable %s evidence",
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
            code: "EACCES",
          });
        }
        return inspect(file);
      });
    }
    expect(inspectOtherOpenClawProcesses()).toEqual({
      pids: [peer],
      warnings: [expect.stringContaining(`PID ${peer}:`)],
    });
  },
);

const aliasArgvs = [
  ["bun", "run", "--silent", "bridge"],
  ["bun", "--silent", "run", "bridge"],
  ["bun", "run", "--silent", "run"],
  ["bun", "--silent", "service.js", "run"],
  ["bun", "--silent", "--", "run"],
  ["tsx", "--foreign-runtime-option", "watch", "watch"],
];
it.each([
  ...foreignArgvs.map((argv) => ({ argv, kind: "foreign" })),
  ...aliasArgvs.map((argv) => ({ argv, kind: "extensionless" })),
  { argv: ["bun", "run", "start"], kind: "task" },
  { argv: ["node", "/unrelated-app/alias.js"], kind: "artifact" },
])("resolves $kind script custody for $argv", ({ argv, kind }) => {
  rows.set(peer, { ppid: 1, argv, cwd: "/unrelated-app" });
  realpath.mockImplementation((file: string) => {
    if (kind === "foreign" && file !== "/unrelated-app/service.js") {
      throw Object.assign(new Error("script does not exist"), { code: "ENOENT" });
    }
    if (
      kind === "task" ||
      (kind === "extensionless" &&
        ["/unrelated-app/bridge", "/unrelated-app/run", "/unrelated-app/watch"].includes(file))
    ) {
      return "/app/openclaw.mjs";
    }
    return kind === "artifact" && file === "/unrelated-app/alias.js"
      ? "/tmp/openclaw-update-runtime-Ab1234/tree/plugin/worker.js"
      : file;
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({
    pids: kind === "foreign" || kind === "task" ? [] : [peer],
  });
});

it.each([
  { options: ["--require=/app", "--future-option"], directory: true, error: undefined },
  {
    options: ["--require", "preload"],
    directory: false,
    error: "runtime module package identity is unavailable",
  },
  ...[
    ["--test-reporter", "/app/reporter.js", false],
    ["--test-reporter", pathToFileURL(path.resolve("/app/reporter.js")).href, false],
    ["--test-reporter", "reporter/register", true],
    ["--foreign-runtime-option", "reporter", true],
    ["--foreign-runtime-option", "/app/reporter.js", false],
  ].map(([option, value, unresolved]) => ({
    options: [`${option}=${value}`, "--test"],
    directory: false,
    error: unresolved ? "package identity is unavailable" : undefined,
  })),
])("inspects module custody for $options", ({ options, directory: isDirectory, error }) => {
  rows.set(peer, {
    ppid: 1,
    argv: ["node", ...options, "/unrelated-app/service.js"],
    cwd: "/unrelated-app",
  });
  if (isDirectory) {
    stat.mockImplementation((file: string) => ({ isDirectory: () => file === "/app" }));
  }
  expect(inspectOtherOpenClawProcesses()).toEqual({
    pids: [peer],
    ...(error ? { warnings: [expect.stringContaining(error)] } : {}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (bunDescriptor) {
    Object.defineProperty(process.versions, "bun", bunDescriptor);
  } else {
    Reflect.deleteProperty(process.versions, "bun");
  }
  if (getuidDescriptor) {
    Object.defineProperty(process, "getuid", getuidDescriptor);
  } else {
    Reflect.deleteProperty(process, "getuid");
  }
});

it("exempts self and its verified Doctor launcher, but not a same-group peer or child", () => {
  rows.set(launcher, { ppid: 1, argv: ["node", "/app/openclaw.mjs", "doctor", "--fix"] });
  rows.set(peer, { ppid: 1, argv: ["openclaw", "doctor"] });
  rows.set(peer + 1, { ppid: self, argv: ["openclaw-models"] });
  rows.set(peer + 2, { ppid: 1, argv: ["python", "worker.py"] });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer, peer + 1] });
});

it.each([
  { argv: ["openclaw-doctor"], verified: false },
  { argv: ["openclaw", "agent", "--message", "openclaw", "doctor"], verified: false },
  { argv: ["node", "/app/openclaw.mjs", "--profile", "work", "doctor", "--fix"], verified: true },
])("exempts only a verified Doctor ancestor: $argv", ({ argv, verified }) => {
  rows.set(launcher, { ppid: 1, argv });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: verified ? [] : [launcher] });
});

it.each([
  "missing self",
  "missing ancestor",
  "unreadable command",
  "failed enumeration",
  "container",
  "win32",
])("does not authorize cleanup with %s", (failure) => {
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
  if (failure === "container") {
    container.mockReturnValue(true);
  }
  if (failure === "win32") {
    mockProcessPlatform("win32");
  }
  const result = inspectOtherOpenClawProcesses();
  if (failure === "container") {
    expect(result).toEqual({ error: expect.stringContaining("Host process visibility") });
    expect(directory).not.toHaveBeenCalled();
  } else if (failure === "win32") {
    expect(result).toEqual({
      error: expect.stringContaining("Exact process command census is unavailable on win32"),
    });
    expect(census).not.toHaveBeenCalled();
  } else {
    expect(result).toHaveProperty("error");
  }
});

it.each([
  { state: "S", flags: 0, dead: false, clear: false },
  { state: "S", flags: 0x0020_0000, dead: false, clear: true },
  { state: "Z", flags: 0, dead: false, clear: false },
  { state: "Z", flags: 0, dead: true, clear: true },
])(
  "requires kernel or death evidence for empty argv ($state, $flags, dead=$dead)",
  ({ state, flags, dead, clear }) => {
    rows.set(peer, { ppid: 1, argv: [], state, flags });
    definitelyDead.mockReturnValue(dead);
    const result = inspectOtherOpenClawProcesses();
    if (clear) {
      expect(result).toEqual({ pids: [] });
    } else {
      expect(result).toHaveProperty("error");
    }
  },
);

it("uses native Darwin arguments and explicit foreign system-service facts", () => {
  mockProcessPlatform("darwin");
  const foreignUid = (process.getuid?.() ?? 501) + 1;
  rows.get(1)!.uid = foreignUid;
  rows.set(peer, { ppid: 1, argv: ["node", "/app with spaces/openclaw.mjs", "status"] });
  census.mockImplementation((command: string) => ({
    status: 0,
    stdout: command.endsWith("lsof")
      ? [...rows].map(([pid, row]) => `p${pid}\0n${row.cwd ?? "/foreign"}\0\n`).join("")
      : [...rows].map(([pid, row]) => `${pid} ${self} S ${row.ppid} ${row.uid ?? 1000}`).join("\n"),
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

it("keeps Rosetta custody uncertain and names native arm64 Node.js for update repair", () => {
  rows.set(peer, { ppid: 1, argv: ["node", "/app/dist/index.js"] });
  mockDarwinBatch({ status: 0, stdout: "" });
  rosetta.mockReturnValue(true);
  darwinCommand.mockImplementation(() => {
    throw new Error(
      "Cannot inspect Darwin process arguments under Rosetta; run OpenClaw with native arm64 Node.js.",
    );
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({
    error: expect.stringContaining("native arm64 Node.js"),
  });
  expect(
    inspectOtherOpenClawProcesses({
      runId: "update-run-123",
      artifactPaths: ["/tmp/retained runtime"],
    }).error,
  ).toBe(
    "Host process census is unavailable under Rosetta; run openclaw update repair with native arm64 Node.js.",
  );
});

function mockDarwinBatch(lsof: { status: number | null; stdout: string; error?: Error }) {
  rows.set(launcher, { ppid: 1, argv: ["node", "/app/openclaw.mjs", "doctor", "--fix"] });
  mockProcessPlatform("darwin");
  census.mockImplementation((command: string) =>
    command.endsWith("lsof")
      ? lsof
      : {
          status: 0,
          stdout: [...rows].map(([pid, row]) => `${pid} ${self} S ${row.ppid} 501`).join("\n"),
        },
  );
  darwinCommand.mockImplementation((pid: number) => ({ argv: rows.get(pid)!.argv }));
}

it.each([peer, launcher, self])(
  "continues after an incomplete Darwin environment for PID %s",
  (incompletePid) => {
    rows.set(peer, { ppid: 1, argv: ["/bin/sleep", "60"] });
    rows.set(peer + 1, { ppid: 1, argv: ["node", "/app/dist/index.js"] });
    mockDarwinBatch({ status: 0, stdout: "" });
    darwinCommand.mockImplementation((pid: number) => {
      if (pid === incompletePid) {
        throw new ProcSafeError("incomplete", "unterminated Darwin environment: private fixture");
      }
      return { argv: rows.get(pid)!.argv };
    });
    expect(inspectOtherOpenClawProcesses()).toEqual({
      pids: incompletePid === self ? [peer + 1] : [incompletePid, peer + 1],
      ...(incompletePid === self
        ? {}
        : {
            warnings: [
              `Could not verify runtime custody for PID ${incompletePid}: process command is unavailable`,
            ],
          }),
    });
  },
);

it("retains Darwin cwd holders from one partial batch without trusting other PID records", () => {
  rows.set(peer, { ppid: 1, argv: ["node", "/vendor/worker.js"] });
  rows.set(peer + 1, { ppid: 1, argv: ["bun", "run", "--silent", "start"] });
  mockDarwinBatch({
    status: 1,
    stdout: `p1\0n/\0\np${peer}\0fcwd\0n/tmp/openclaw-plugin-build-abc123/package\0\np999999999\0n/tmp/openclaw-update-runtime-Ab1234\0\np${peer + 1}\0n/tmp/unrelated\0`,
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
  expect(census.mock.calls.filter(([command]) => command.endsWith("lsof"))).toHaveLength(1);
});

it.each([
  { script: "dist/index.js", partial: false },
  { script: "/unrelated-app/dist/index.js", partial: true },
])("retains processes after an incomplete cwd batch ($script)", ({ script, partial }) => {
  rows.set(peer, { ppid: 1, argv: ["node", script] });
  mockDarwinBatch(
    partial
      ? { status: 1, stdout: `p1\0n/\0` }
      : {
          status: null,
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          stdout: "",
        },
  );
  expect(inspectOtherOpenClawProcesses()).toEqual({
    pids: [peer],
    warnings: [expect.stringContaining(`PID ${peer}: working directory is unavailable`)],
  });
});

const references = { runId: "update-run-123", artifactPaths: ["/tmp/retained runtime"] };
const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });

it.each([
  ["/usr/lib/systemd/systemd", "--user"],
  ["/usr/lib/systemd/systemd", "--user", "--deserialize=8"],
  ["/lib/systemd/systemd", "--user", "--deserialize=23"],
])("does not let protected systemd login processes block update-repair evidence: %j", (...argv) => {
  rows.set(peer, {
    ppid: 1,
    argv,
    uid: 1000,
    cwd: denied(),
  });
  rows.set(peer + 1, { ppid: peer, argv: ["(sd-pam)"], uid: 1000, cwd: denied() });
  const handoffRefs = {
    runId: "systemd-update-run",
    artifactPaths: ["/tmp/openclaw-update-runtime-Ab1234"],
  };
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
  expect(inspectOtherOpenClawProcesses(handoffRefs)).toEqual({
    matchingPids: [],
    unverifiedPids: [],
  });
  rows.get(peer + 1)!.cwd = handoffRefs.artifactPaths[0];
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer + 1] });
  expect(inspectOtherOpenClawProcesses(handoffRefs)).toEqual({
    matchingPids: [peer + 1],
    unverifiedPids: [],
  });
  rows.get(peer + 1)!.cwd = denied();
  rows.get(peer + 1)!.ppid = 1;
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
  expect(inspectOtherOpenClawProcesses(handoffRefs)).toEqual({
    matchingPids: [],
    unverifiedPids: [peer + 1],
    warnings: [expect.stringContaining(`PID ${peer + 1}`)],
  });
});

it.each([0, 1000])(
  "ignores unrelated non-runtime commands with unavailable cwd (UID %i)",
  (uid) => {
    rows.set(peer, { ppid: 1, argv: ["/bin/sh", "worker.sh"], uid, cwd: denied() });
    expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
  },
);

it.each([
  ["node", "--eval", "1"],
  ["bun", "run", "--silent", "start"],
  ["tsx", "--foreign-runtime-option", "watch", "worker.ts"],
])("retains unresolved runtime processes without cwd for %j", (...argv) => {
  rows.set(peer, { ppid: 1, argv, uid: 0, cwd: denied() });
  expect(inspectOtherOpenClawProcesses()).toEqual({
    pids: [peer],
    warnings: [expect.stringContaining(`PID ${peer}:`)],
  });
});

it.each([
  { argv: ["/usr/bin/worker", "/tmp/openclaw-update-runtime-Ab1234/tree/worker.js"] },
  { argv: ["/usr/bin/worker"], cwd: "/tmp/openclaw-update-runtime-Ab1234/tree" },
  { argv: ["openclaw-gateway"] },
  { argv: ["node", "--eval", "1"], environment: "OPENCLAW_SERVICE_MARKER=openclaw\0" },
])("preserves foreign retained-runtime and OpenClaw evidence for $argv", (facts) => {
  rows.set(peer, { ppid: 1, uid: 0, cwd: denied(), ...facts });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
});

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
      darwinCommand.mockImplementation((pid: number, owner: "different") =>
        rows.get(pid)?.commandError
          ? { argvUnavailable: true, owner }
          : { argv: rows.get(pid)!.argv },
      );
    }
    expect(inspectOtherOpenClawProcesses(references)).toEqual({
      matchingPids: [peer + 2, peer + 3],
      unverifiedPids: [peer],
      warnings: [expect.stringContaining(`PID ${peer}`)],
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
      ...(!foreign ? { warnings: [expect.stringContaining(`PID ${peer}`)] } : {}),
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
