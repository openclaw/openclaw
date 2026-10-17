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
  nativeDarwinCensus,
  rosetta,
  windows,
  windowsSid,
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
  windows: vi.fn(),
  windowsSid: vi.fn(),
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
// mock-isolation: Enumerate only fixture PIDs, including when Bun selects native libproc.
vi.mock("../process/supervisor/darwin-bun-process-census.js", () => ({
  readDarwinBunProcessCensus: nativeDarwinCensus,
}));
vi.mock("../process/supervisor/darwin-process-command.js", () => ({
  readDarwinProcessCommand: darwinCommand,
}));
vi.mock("./windows-process-census.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-process-census.js")>()),
  readWindowsProcessCensus: windows,
}));
vi.mock("./windows-user-sid.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windows-user-sid.js")>()),
  readWindowsUserSid: windowsSid,
}));
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";

const self = process.pid;
const launcher = self + 1;
const peer = self + 2;
const peerPids = (...offsets: number[]) => offsets.map((offset) => peer + offset);
const runtimeRoot = "/tmp/openclaw-update-runtime-Ab1234";
const pluginRoot = "/tmp/openclaw-plugin-build-abc123";
const retainedRoot = "/tmp/retained runtime";
const references = { runId: "update-run-123", artifactPaths: [retainedRoot] };
const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });
function fail(message: string, code = "EACCES"): never {
  throw Object.assign(new Error(message), { code });
}
const expectPids = (pids: number[]) => expect(inspectOtherOpenClawProcesses()).toEqual({ pids });
const expectError = (text: string) =>
  expect(inspectOtherOpenClawProcesses()).toEqual({ error: expect.stringContaining(text) });
function expectHandoff(
  matchingPids: number[],
  unverifiedPids: number[] = [],
  options: typeof references & {
    windowsUserSid?: string;
    drivers?: { pid: number; startIdentity: string }[];
  } = references,
  error?: string,
) {
  expect(inspectOtherOpenClawProcesses(options)).toEqual({
    matchingPids,
    unverifiedPids,
    ...(error ? { error } : {}),
  });
}
function overrideRead(matches: (file: string) => boolean, replacement: (file: string) => string) {
  const original = read.getMockImplementation()!;
  read.mockImplementation((file: string) => (matches(file) ? replacement(file) : original(file)));
}
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
const psOutput = (uid?: number) =>
  [...rows]
    .map(([pid, row]) => `${pid} ${self} S ${row.ppid} ${uid ?? row.uid ?? 1000}`)
    .join("\n");
const setProcess = (pid: number, argv: string[], facts: Partial<Omit<Process, "argv">> = {}) =>
  rows.set(pid, { ppid: 1, argv, ...facts });
const cwdOutput = (pids: number[], fallback = "/app") =>
  pids
    .flatMap((pid) => {
      const cwd = rows.get(pid)?.cwd ?? fallback;
      return cwd instanceof Error ? [] : [`p${pid}\0n${cwd}\0\n`];
    })
    .join("");
function failRead(matches: (file: string) => boolean, code = "EACCES", message = "denied") {
  overrideRead(matches, () => fail(message, code));
}

beforeEach(() => {
  // This synthetic kernel exercises the Node ps contract, including on Bun hosts.
  Object.defineProperty(process.versions, "bun", { configurable: true, value: undefined });
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
  darwinCommand
    .mockReset()
    .mockImplementation((pid: number, uid: number) =>
      rows.get(pid)?.commandError ? { argvUnavailable: true, uid } : { argv: rows.get(pid)!.argv },
    );
  nativeDarwinCensus.mockReset().mockImplementation(() =>
    [...rows].map(([pid, row]) => ({
      pid,
      ppid: row.ppid,
      pgid: self,
      state: row.state ?? "S",
      uid: row.uid ?? 1000,
    })),
  );
  rosetta.mockReset().mockReturnValue(false);
  windows.mockReset();
  windowsSid.mockReset();
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
      fail("Process disappeared", "ENOENT");
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
  [["node", "dist/index.js"], { cwd: "/unrelated-app" }, false],
  [["node", "/unrelated-app/dist/index.js"], { cwd: "/unrelated-app" }, false],
  [["node", "dist/index.js"], { cwd: "/app" }, true],
  [
    ["node", "--eval", "import(process.argv[1])", `${runtimeRoot}/tree/2f/app/dist/terminal.js`],
    {},
    true,
  ],
  [["bun", "run", "--silent", "start"], { cwd: `${pluginRoot}/package` }, true],
  [["node", "/vendor/worker.js"], { cwd: `${pluginRoot}/package` }, true],
  [["node", "/vendor/renamed.js"], { environment: "OPENCLAW_SERVICE_MARKER=openclaw\0" }, true],
  ...[
    ["openclaw-gateway"],
    ["node", "/app/src/agents/prepared-model-catalog.worker.ts"],
    [`${pluginRoot}/node_modules/vendor/codex`],
    ["bun", "run", "--silent", "start", "--config=openclaw-plugin-build-abc123/config.json"],
    ["bun", "run", "--silent", "/app/dist/index.js"],
    ["node", "-r/app/dist/index.js", "/unrelated-app/service.js"],
    ["node", "/tmp/openclaw-model-catalog-abc123/worker.cjs"],
  ].map((argv): CustodyCase => [argv, {}, true]),
];
it.each(custodyCases)("classifies artifact custody of %j with %j", (argv, facts, holder) => {
  setProcess(peer, argv, { ...facts });
  expectPids(holder ? [peer] : []);
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
  ["/app/dist/index.js", "denied"],
  ["/app/dist/index.js", "unnamed"],
  ["/app/service.js", "missing"],
])("vetoes absolute entrypoint %s with %s package identity", (script, failure) => {
  setProcess(peer, ["node", script]);
  overrideRead(
    (file) => file.endsWith("/package.json"),
    () => {
      if (failure === "unnamed") {
        return JSON.stringify({});
      }
      fail("unreadable manifest", failure === "denied" ? "EACCES" : "ENOENT");
    },
  );
  expectError("package identity");
});

it.each(["script", "service-marker", "module-package", "directory-package"])(
  "vetoes unreadable %s evidence",
  (source) => {
    setProcess(
      peer,
      source === "directory-package"
        ? ["node", "--require=/app", "/unrelated-app/dist/index.js"]
        : source === "module-package"
          ? ["node", "--require=/app/dist/index.js", "/unrelated-app/dist/index.js"]
          : ["node", "/unrelated-app/dist/index.js"],
      { cwd: "/unrelated-app" },
    );
    if (source === "directory-package") {
      stat.mockImplementation((file: string) => ({ isDirectory: () => file === "/app" }));
    }
    if (source === "script") {
      realpath.mockImplementation((file: string) => {
        if (file === "/unrelated-app/dist/index.js") {
          fail("script disappeared", "ENOENT");
        }
        return file;
      });
    } else {
      failRead(
        (file) =>
          file === (source.endsWith("package") ? "/app/package.json" : `/proc/${peer}/environ`),
        source === "directory-package" ? "ENOENT" : "EACCES",
        "inspection failed",
      );
    }
    expect(inspectOtherOpenClawProcesses()).toHaveProperty("error");
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
  setProcess(peer, argv, { cwd: "/unrelated-app" });
  realpath.mockImplementation((file: string) => {
    if (kind === "foreign" && file !== "/unrelated-app/service.js") {
      fail("script does not exist", "ENOENT");
    }
    if (
      kind === "task" ||
      (kind === "extensionless" &&
        ["/unrelated-app/bridge", "/unrelated-app/run", "/unrelated-app/watch"].includes(file))
    ) {
      return "/app/openclaw.mjs";
    }
    return kind === "artifact" && file === "/unrelated-app/alias.js"
      ? `${runtimeRoot}/tree/plugin/worker.js`
      : file;
  });
  expectPids(kind === "foreign" || kind === "task" ? [] : [peer]);
});

it.each<[string[], boolean, string?]>([
  [["--require=/app", "--future-option"], true],
  [["--require", "preload"], false, "runtime module package identity is unavailable"],
  ...[
    ["--test-reporter", "/app/reporter.js", false],
    ["--test-reporter", pathToFileURL(path.resolve("/app/reporter.js")).href, false],
    ["--test-reporter", "reporter/register", true],
    ["--foreign-runtime-option", "reporter", true],
    ["--foreign-runtime-option", "/app/reporter.js", false],
  ].map(([option, value, unresolved]): [string[], boolean, string?] => [
    [`${option}=${value}`, "--test"],
    false,
    unresolved ? "package identity is unavailable" : undefined,
  ]),
])("inspects module custody for %j", (options, isDirectory, error) => {
  setProcess(peer, ["node", ...options, "/unrelated-app/service.js"], { cwd: "/unrelated-app" });
  if (isDirectory) {
    stat.mockImplementation((file: string) => ({ isDirectory: () => file === "/app" }));
  }
  expect(inspectOtherOpenClawProcesses()).toEqual(
    error ? { error: expect.stringContaining(error) } : { pids: [peer] },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreProperty(process.versions, "bun", bunDescriptor);
  restoreProperty(process, "getuid", getuidDescriptor);
});
function restoreProperty(target: object, key: string, descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    Reflect.deleteProperty(target, key);
  }
}

it("exempts self and its verified Doctor launcher, but not a same-group peer or child", () => {
  setProcess(peer, ["openclaw", "doctor"]);
  setProcess(peer + 1, ["openclaw-models"], { ppid: self });
  setProcess(peer + 2, ["python", "worker.py"]);
  expectPids([peer, peer + 1]);
});

it.each([
  { argv: ["openclaw-doctor"], verified: false },
  { argv: ["openclaw", "agent", "--message", "openclaw", "doctor"], verified: false },
  { argv: ["node", "/app/openclaw.mjs", "--profile", "work", "doctor", "--fix"], verified: true },
])("exempts only a verified Doctor ancestor: $argv", ({ argv, verified }) => {
  setProcess(launcher, argv);
  expectPids(verified ? [] : [launcher]);
});

it.each<[string, () => unknown, string?, typeof directory?]>([
  ["missing self", () => rows.delete(self)],
  ["missing ancestor", () => rows.delete(launcher)],
  ["unreadable command", () => failRead((file) => file.endsWith("/cmdline"))],
  ["failed enumeration", () => directory.mockImplementation(() => fail("denied"))],
  ["container", () => container.mockReturnValue(true), "Host process visibility", directory],
  [
    "win32",
    () => mockProcessPlatform("win32"),
    "Exact process command census is unavailable on win32",
    census,
  ],
])("does not authorize cleanup with %s", (_failure, arrange, error, untouched) => {
  arrange();
  const result = inspectOtherOpenClawProcesses();
  if (error) {
    expect(result).toEqual({ error: expect.stringContaining(error) });
  } else {
    expect(result).toHaveProperty("error");
  }
  if (untouched) {
    expect(untouched).not.toHaveBeenCalled();
  }
});

it.each([
  { state: "S", flags: 0, dead: false, clear: false },
  { state: "S", flags: 0x0020_0000, dead: false, clear: true },
  { state: "Z", flags: 0, dead: false, clear: false },
  { state: "Z", flags: 0, dead: true, clear: true },
])("requires empty-argv proof ($state, $flags, $dead)", ({ state, flags, dead, clear }) => {
  setProcess(peer, [], { state, flags });
  definitelyDead.mockReturnValue(dead);
  const result = inspectOtherOpenClawProcesses();
  if (clear) {
    expect(result).toEqual({ pids: [] });
  } else {
    expect(result).toHaveProperty("error");
  }
});

it("uses native Darwin arguments and explicit foreign system-service facts", () => {
  mockProcessPlatform("darwin");
  const foreignUid = (process.getuid?.() ?? 501) + 1;
  rows.get(1)!.uid = foreignUid;
  setProcess(peer, ["node", "/app with spaces/openclaw.mjs", "status"]);
  census.mockImplementation((command: string) => ({
    status: 0,
    stdout: command.endsWith("lsof") ? cwdOutput([...rows.keys()], "/foreign") : psOutput(),
  }));
  darwinCommand.mockImplementation((pid: number) =>
    pid === 1
      ? { argvUnavailable: true, executable: "/sbin/launchd", uid: foreignUid }
      : { argv: rows.get(pid)!.argv },
  );
  expectPids([peer]);
  setProcess(peer, ["node", "/unrelated-app/dist/index.js"]);
  expectPids([]);
  setProcess(peer, ["node", "/app/dist/index.js"]);
  expectPids([peer]);
  rows.delete(peer);
  expectPids([]);
  rows.get(1)!.cwd = `${pluginRoot}/package`;
  expectPids([1]);
  rows.get(1)!.cwd = undefined;
  darwinCommand.mockImplementation(() => {
    throw new Error("unreadable live process");
  });
  expectError("unreadable live process");
});

it("keeps Rosetta custody uncertain and names native arm64 Node.js for update repair", () => {
  setProcess(peer, ["node", "/app/dist/index.js"]);
  mockDarwinBatch({ status: 0, stdout: "" });
  rosetta.mockReturnValue(true);
  darwinCommand.mockImplementation(() => {
    throw new Error(
      "Cannot inspect Darwin process arguments under Rosetta; run OpenClaw with native arm64 Node.js.",
    );
  });
  expectError("native arm64 Node.js");
  expect(inspectOtherOpenClawProcesses(references).error).toBe(
    "Host process census is unavailable under Rosetta; run openclaw update repair with native arm64 Node.js.",
  );
});

function mockDarwinBatch(lsof: { status: number | null; stdout: string; error?: Error }) {
  mockProcessPlatform("darwin");
  census.mockImplementation((command: string) =>
    command.endsWith("lsof")
      ? lsof
      : {
          status: 0,
          stdout: psOutput(501),
        },
  );
}

it("retains Darwin cwd holders from one partial batch without trusting other PID records", () => {
  setProcess(peer, ["node", "/vendor/worker.js"]);
  setProcess(peer + 1, ["bun", "run", "--silent", "start"]);
  mockDarwinBatch({
    status: 1,
    stdout: `p1\0n/\0\np${peer}\0fcwd\0n/tmp/openclaw-plugin-build-abc123/package\0\np999999999\0n/tmp/openclaw-update-runtime-Ab1234\0\np${peer + 1}\0n/tmp/unrelated\0`,
  });
  expectPids([peer]);
  expect(census.mock.calls.filter(([command]) => command.endsWith("lsof"))).toHaveLength(1);
});

it.each([
  { script: "dist/index.js", partial: false },
  { script: "/unrelated-app/dist/index.js", partial: true },
])("vetoes an incomplete cwd batch for $script (partial=$partial)", ({ script, partial }) => {
  setProcess(peer, ["node", script]);
  mockDarwinBatch(
    partial
      ? { status: 1, stdout: `p1\0n/\0` }
      : {
          status: null,
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          stdout: "",
        },
  );
  expectError("working directory is unavailable");
});

it.each(["/usr/lib/systemd/systemd", "/lib/systemd/systemd"])(
  "does not let the user manager pin abandoned runtimes when cwd is denied (%s)",
  (executable) => {
    setProcess(peer, [executable, "--user"], { uid: 1000, cwd: denied() });
    expectPids([]);
    rows.get(peer)!.cwd = runtimeRoot;
    expectPids([peer]);
    rows.get(peer)!.cwd = denied();
    rows.get(peer)!.argv.push(runtimeRoot);
    expectPids([peer]);
  },
);

it.each([false, true])("excludes only the user manager's PAM helper (repair=%s)", (repair) => {
  setProcess(peer, ["/usr/lib/systemd/systemd", "--user"], { uid: 1000, cwd: denied() });
  setProcess(peer + 1, ["(sd-pam)"], { ppid: peer, uid: 1000, cwd: denied() });
  const handoffRefs = {
    runId: "systemd-update-run",
    artifactPaths: [runtimeRoot],
  };
  const assertPids = (matchingPids: number[]) => {
    if (repair) {
      expectHandoff(matchingPids, [], handoffRefs);
    } else {
      expectPids(matchingPids);
    }
  };
  assertPids([]);
  rows.get(peer + 1)!.cwd = handoffRefs.artifactPaths[0];
  assertPids([peer + 1]);
  rows.get(peer + 1)!.cwd = denied();
  rows.get(peer + 1)!.ppid = 1;
  if (repair) {
    expectHandoff([], [peer + 1], handoffRefs);
  } else {
    expectError(`Could not classify PID ${peer + 1}: working directory is unavailable`);
  }
});

it.each(["foreign", "same", "unknown process", "unknown inspector"])(
  "requires a positively foreign UID to exclude systemd with denied cwd (%s)",
  (owner) => {
    setProcess(1, ["/usr/lib/systemd/systemd", "--system"], {
      ppid: 0,
      uid: owner === "same" ? 1000 : 0,
      cwd: denied(),
    });
    if (owner === "unknown process") {
      failRead((file) => file === "/proc/1/status");
    } else if (owner === "unknown inspector") {
      Reflect.deleteProperty(process, "getuid");
    }
    if (owner === "foreign") {
      expectPids([]);
    } else {
      expectError("Could not classify PID 1: working directory is unavailable");
    }
  },
);

it.each([
  ["node", "--eval", "1"],
  ["bun", "run", "--silent", "start"],
  ["tsx", "--foreign-runtime-option", "watch", "worker.ts"],
])("keeps foreign runtime custody unresolved without cwd for %j", (...argv) => {
  setProcess(peer, argv, { uid: 0, cwd: denied() });
  expectError(`Could not classify PID ${peer}: working directory is unavailable`);
});

it.each([
  { argv: ["/usr/bin/worker", `${runtimeRoot}/tree/worker.js`] },
  { argv: ["/usr/bin/worker"], cwd: `${runtimeRoot}/tree` },
  { argv: ["openclaw-gateway"] },
  { argv: ["node", "--eval", "1"], environment: "OPENCLAW_SERVICE_MARKER=openclaw\0" },
])("preserves foreign retained-runtime and OpenClaw evidence for $argv", (facts) => {
  rows.set(peer, { ppid: 1, uid: 0, cwd: denied(), ...facts });
  expectPids([peer]);
});

it("finds orphaned handoff references while excluding only its verified updater launcher", () => {
  setProcess(launcher, ["node", "/app/openclaw.mjs", "update", "repair", references.runId]);
  setProcess(peer, ["node", "--run-id=update-run-123"]);
  setProcess(peer + 1, ["node", "worker.js"], { cwd: `${retainedRoot}/tree` });
  setProcess(peer + 2, ["node", `${retainedRoot}/tree/worker.js`]);
  setProcess(peer + 3, [
    "node",
    "update-run-1234",
    `${retainedRoot}-other`,
    `${retainedRoot}.old/worker.js`,
  ]);
  setProcess(peer + 4, ["node", "other-update-run-123", "/different/tmp/retained runtime"]);
  setProcess(peer + 5, [
    "node",
    "--eval",
    'import("file:///tmp/retained%20runtime/tree/worker.js")',
  ]);
  expectHandoff([peer, peer + 1, peer + 2, peer + 5], []);
  setProcess(launcher, ["openclaw-update", references.runId]);
  expect(inspectOtherOpenClawProcesses(references).matchingPids).toContain(launcher);
});

it.each(["linux", "darwin"] as const)(
  "checks readable handoff references before excluding opaque foreign %s processes",
  (platform) => {
    mockProcessPlatform(platform);
    setProcess(peer, ["node", "worker.js"], { cwd: denied() });
    setProcess(peer + 1, [], { uid: 2000, commandError: denied(), cwd: denied() });
    setProcess(peer + 2, [], {
      uid: 2000,
      commandError: denied(),
      cwd: `${retainedRoot}/tree`,
    });
    setProcess(peer + 3, ["node", references.runId], { uid: 2000, cwd: denied() });
    if (platform === "darwin") {
      census.mockImplementation((command: string, args: string[]) => {
        return command === "/bin/ps"
          ? { status: 0, stdout: psOutput() }
          : { status: 1, stdout: cwdOutput(args[args.indexOf("-p") + 1]!.split(",").map(Number)) };
      });
    }
    expectHandoff([peer + 2, peer + 3], [peer]);
  },
);

it("names an unreadable same-user PID without exposing its process data", () => {
  setProcess(peer, [], {
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
] as const)("checks all Linux credential UIDs: %s", (uids, foreign) => {
  setProcess(peer, ["node", "worker.js"], { uid: 2000, cwd: denied() });
  overrideRead(
    (file) => file === `/proc/${peer}/status`,
    () => `Uid:\t${uids}\n`,
  );
  expectHandoff([], foreign ? [] : [peer]);
});

it.each([
  ...[
    "openclaw update repair --run-id=update-run-123",
    String.raw`node --title "" "C:\app\openclaw.mjs" update repair --run-id=update-run-123`,
    String.raw`"C:\Program Files\node.exe" --title "C:\Team Notes\\" "C:\app\openclaw.mjs" update repair --run-id=update-run-123`,
  ].map((commandLine) => ({ parentStart: 100, commandLine })),
  { parentStart: 200, commandLine: "openclaw update repair --run-id=update-run-123" },
])("verifies Windows ancestor $parentStart/$commandLine", ({ parentStart, commandLine }) => {
  mockProcessPlatform("win32");
  windows.mockReturnValue([
    processRow(self, "openclaw update repair", { parentPid: launcher, startIdentity: "200" }),
    processRow(launcher, commandLine, { startIdentity: String(parentStart) }),
    processRow(peer, 'node "C:\\Temp\\Retained Runtime\\tree\\worker.js"'),
    processRow(peer + 1, "node worker.js", { cwd: "c:/temp/retained runtime/tree" }),
    { pid: peer + 2 },
    { pid: peer + 3, foreignOwner: true },
    { pid: peer + 4, foreignOwner: true, commandLine: "node --id=update-run-123" },
    processRow(peer + 5, "node worker.js", { cwd: "\\\\?\\C:\\Temp\\Retained Runtime\\tree" }),
    processRow(peer + 6, 'node "file:///C:/Temp/Retained%20Runtime/tree/worker.js"'),
    processRow(peer + 7, '"unterminated.exe'),
    processRow(peer + 8, "node\0 --id=update-run-123"),
    processRow(peer + 9, ""),
  ]);
  expectHandoff(
    [...(parentStart >= 200 ? [launcher] : []), ...peerPids(0, 1, 4, 5, 6, 8)],
    [peer + 2, peer + 7, peer + 9],
    { ...references, artifactPaths: ["c:\\temp\\retained runtime"] },
    sameAccountError,
  );
});

it.each(["denied", "empty"])("preserves Doctor's refusal for foreign Linux %s argv", (kind) => {
  setProcess(peer, [], { uid: 2000, ...(kind === "denied" ? { commandError: denied() } : {}) });
  expect(inspectOtherOpenClawProcesses()).toHaveProperty("error");
});

type WindowsRow = ReturnType<
  typeof import("./windows-process-census.js").readWindowsProcessCensus
>[number];
const processRow = (pid: number, commandLine: string, facts: Partial<WindowsRow> = {}) => ({
  pid,
  commandLine,
  parentPid: 0,
  cwd: "C:\\app",
  ...facts,
});
type HandoffCase = [
  name: string,
  facts: Omit<WindowsRow, "pid">,
  outcome: "clear" | "match" | "unverified",
  options?: { sid?: string; legacy?: boolean; parents?: WindowsRow[] },
];
const child = (parentPid: number, startIdentity: string) => ({ parentPid, startIdentity });
const deniedFacts = { accessDenied: true } as const;
const sameAccountError =
  "Please run update repair as the same Windows account that started the update.";
const deniedParent = { parents: [{ pid: peer + 10, accessDenied: true }] };
it.each<HandoffCase>([
  ["denied same account", deniedFacts, "clear"],
  ["denied other account", deniedFacts, "unverified", { sid: "S-1-5-21-200" }],
  ["denied unknown caller", deniedFacts, "unverified", { sid: undefined }],
  ["denied legacy record", deniedFacts, "unverified", { legacy: true }],
  ["missing identity", {}, "unverified"],
  ["protected unrelated process", child(peer + 10, "100"), "clear"],
  ["reused parent PID", child(launcher, "100"), "clear"],
  ["readable other account", child(peer + 10, "100"), "clear", { sid: "S-1-5-21-200" }],
  ["same-millisecond descendant", child(launcher, "200"), "match"],
  ["unreadable descendant", child(launcher, "300"), "match"],
  ["exited intermediate parent", child(peer + 10, "300"), "unverified"],
  ["denied parent", child(peer + 10, "300"), "unverified", deniedParent],
  ["readable descendant", processRow(peer, "node worker.js", child(launcher, "300")), "match"],
  ["artifact on denied row", { ...deniedFacts, commandLine: "node --id=update-run-123" }, "match"],
])("Windows handoff repair census: %s", (_name, facts, outcome, options = {}) => {
  const { sid, legacy, parents } = { sid: "S-1-5-21-100", ...options };
  const matching = outcome === "match",
    unverified = outcome === "unverified";
  mockProcessPlatform("win32");
  windowsSid.mockReturnValue(sid);
  windows.mockReturnValue([
    processRow(self, "openclaw update repair", { startIdentity: "400" }),
    { pid: peer, ...facts },
    ...(parents ?? []),
  ]);
  expectHandoff(
    matching ? [peer] : [],
    unverified ? [peer] : [],
    {
      ...references,
      windowsUserSid: legacy ? undefined : "S-1-5-21-100",
      drivers: [{ pid: launcher, startIdentity: "200" }],
    },
    unverified ? sameAccountError : undefined,
  );
});

it("retains known matching PIDs when later inspection exhausts the census budget", () => {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  setProcess(peer, ["node", references.runId]);
  setProcess(peer + 1, ["node", "worker.js"]);
  setProcess(peer + 2, ["node", "worker.js"]);
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
