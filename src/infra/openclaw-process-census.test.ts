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
  ancestry,
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
  ancestry: vi.fn(),
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
vi.mock("../shared/pid-alive.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/pid-alive.js")>()),
  isPidDefinitelyDead: definitelyDead,
}));
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
// mock-isolation: Native ancestry would otherwise read real host PIDs behind the synthetic table.
vi.mock("@openclaw/proc-safe/identity", () => ({ readProcessAncestry: ancestry }));
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
function processRow(pid: number, argv: string[], facts: Partial<Omit<Process, "argv">> = {}) {
  rows.set(pid, { ppid: 1, argv, ...facts });
}
function expectPids(pids: readonly number[], warning?: string, runtime?: string) {
  expect(inspectOtherOpenClawProcesses(runtime)).toEqual({
    pids,
    ...(warning ? { warnings: [expect.stringContaining(warning)] } : {}),
  });
}

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
  ancestry.mockReset().mockReturnValue(null);
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
      : `${pid} (name ) (with\nparentheses) ${row.state ?? "S"} ${row.ppid} ${self} 0 0 0 ${row.flags ?? 0} ${"0 ".repeat(12)}100`;
  });
});

type CustodyCase = [argv: string[], facts: Partial<Omit<Process, "argv" | "ppid">>];
const custodyCases: CustodyCase[] = [
  [["node", "/vendor/worker.js"], { uid: 0, cwd: "/tmp/openclaw-plugin-build-abc123/package" }],
  [["node", "/vendor/renamed.js"], { uid: 0, environment: "OPENCLAW_SERVICE_MARKER=openclaw\0" }],
  [["node", "/app/src/agents/prepared-model-catalog.worker.ts"], {}],
  [["/tmp/openclaw-plugin-build-abc123/node_modules/vendor/codex"], {}],
];
it.each(custodyCases)("classifies artifact custody of %j with %j", (argv, facts) => {
  processRow(peer, argv, facts);
  expect(inspectOtherOpenClawProcesses()).toMatchObject({ pids: [peer] });
});

it.each([
  ["node", "/standalone/server.mjs"],
  ["node", "-e", "setInterval(() => {}, 1e9)"],
])("finishes the census for manifest-free %j without losing a later holder", (...argv) => {
  processRow(peer, argv, { cwd: "/standalone" });
  processRow(peer + 1, ["node", "/app/dist/index.js"]);
  const inspect = read.getMockImplementation()!;
  read.mockImplementation((file: string) => {
    if (file.endsWith("/package.json") && file !== "/app/package.json") {
      throw Object.assign(new Error("no manifest"), { code: "ENOENT" });
    }
    return inspect(file);
  });
  expectPids([peer + 1]);
  rows.delete(peer + 1);
  expectPids([]);
});

it.each([
  { argv: ["node", "worker.js"], uid: 1000 },
  { argv: ["/usr/bin/node", "-e", "1"], uid: 0 },
])("retains unavailable cwd for $argv without losing scoped holders", ({ argv, uid }) => {
  const held = "/tmp/openclaw-update-runtime-Held01";
  const free = "/tmp/openclaw-update-runtime-Free01";
  processRow(peer, argv, { uid, cwd: denied() });
  processRow(peer + 1, ["node", `${held}/worker.js`]);
  for (const [runtime, pids] of [
    [undefined, [peer, peer + 1]],
    [free, [peer]],
    [held, [peer, peer + 1]],
  ] as const) {
    expectPids(pids, `PID ${peer}: working directory is unavailable`, runtime);
  }
  rows.delete(peer);
  expectPids([], undefined, free);
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
    processRow(
      peer,
      source === "relative"
        ? ["node", "../openclaw-update-runtime-Held01/worker.js"]
        : source === "alias"
          ? ["node", alias]
          : ["node", `--require=${held}/preload.js`, `${held}/worker.js`],
      {
        cwd: source === "cwd-and-preload" ? other : "/tmp/launch",
      },
    );
    expectPids([peer], undefined, held);
    expectPids(source === "cwd-and-preload" ? [peer] : [], undefined, other);
    expectPids([], undefined, "/tmp/openclaw-update-runtime-None01");
  },
);

it("preserves unresolved artifact evidence when cwd proves foreign", () => {
  processRow(
    peer,
    [
      "node",
      "--future-option",
      "-r",
      "/unrelated-app/preload.js",
      "-e",
      "require('/tmp/openclaw-update-runtime-Held01/worker.js')",
    ],
    { cwd: "/unrelated-app" },
  );
  realpath.mockImplementation((file: string) => {
    if (file.includes("require(")) {
      throw Object.assign(new Error("not a path"), { code: "ENOENT" });
    }
    return file;
  });
  expectPids([peer], "could not resolve script");
});

it.each(["service marker", "unnamed package"])(
  "retains uncertain runtime custody with %s",
  (source) => {
    processRow(peer, ["node", "/unrelated-app/dist/index.js"], { cwd: "/unrelated-app" });
    const inspect = read.getMockImplementation()!;
    read.mockImplementation((file: string) => {
      if (source === "unnamed package" && file.endsWith("/package.json")) {
        return "{}";
      }
      if (source === "service marker" && file === `/proc/${peer}/environ`) {
        throw denied();
      }
      return inspect(file);
    });
    expectPids([peer], `PID ${peer}:`);
  },
);

it.each(["bridge", "start"])("distinguishes a Bun file from a package task: %s", (script) => {
  processRow(peer, ["bun", "run", "--silent", script], { cwd: "/unrelated-app" });
  realpath.mockImplementation((file: string) =>
    file === `/unrelated-app/${script}` ? "/app/openclaw.mjs" : file,
  );
  expectPids(script === "start" ? [] : [peer]);
});

it.each([
  { options: ["--require=/app", "--future-option"], directory: true, error: undefined },
  {
    options: ["--require", "preload"],
    directory: false,
    error: "runtime module package identity is unavailable",
  },
  ...["/app/reporter.js", pathToFileURL(path.resolve("/app/reporter.js")).href].map((value) => ({
    options: [`--test-reporter=${value}`, "--test"],
    directory: false,
    error: undefined,
  })),
])("inspects module custody for $options", ({ options, directory: isDirectory, error }) => {
  processRow(peer, ["node", ...options, "/unrelated-app/service.js"], { cwd: "/unrelated-app" });
  if (isDirectory) {
    stat.mockImplementation((file: string) => ({ isDirectory: () => file === "/app" }));
  }
  expectPids([peer], error);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [target, key, descriptor] of [
    [process.versions, "bun", bunDescriptor],
    [process, "getuid", getuidDescriptor],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(target, key, descriptor);
    } else {
      Reflect.deleteProperty(target, key);
    }
  }
});

it("exempts self and its verified Doctor launcher, but not a same-group peer or child", () => {
  processRow(launcher, ["node", "/app/openclaw.mjs", "doctor", "--fix"]);
  processRow(peer, ["openclaw", "doctor"]);
  processRow(peer + 1, ["openclaw-models"], { ppid: self });
  processRow(peer + 2, ["python", "worker.py"]);
  expectPids([peer, peer + 1]);
});

it.each([
  { argv: ["openclaw-doctor"], verified: false },
  { argv: ["openclaw", "agent", "--message", "openclaw", "doctor"], verified: false },
  { argv: ["node", "/app/openclaw.mjs", "--profile", "work", "doctor", "--fix"], verified: true },
])("exempts only a verified Doctor ancestor: $argv", ({ argv, verified }) => {
  processRow(launcher, argv);
  expectPids(verified ? [] : [launcher]);
});

it.each(["missing self", "missing ancestor", "failed enumeration", "container", "win32"])(
  "does not authorize cleanup with %s",
  (failure) => {
    if (failure === "missing self") {
      rows.delete(self);
    }
    if (failure === "missing ancestor") {
      rows.delete(launcher);
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
  },
);

it.each([
  { state: "S", flags: 0, dead: false, clear: false },
  { state: "S", flags: 0x0020_0000, dead: false, clear: true },
  { state: "Z", flags: 0, dead: false, clear: false },
  { state: "Z", flags: 0, dead: true, clear: true },
])(
  "requires kernel or death evidence for empty argv ($state, $flags, dead=$dead)",
  ({ state, flags, dead, clear }) => {
    processRow(peer, [], { state, flags });
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
  processRow(peer, ["node", "/app with spaces/openclaw.mjs", "status"]);
  census.mockImplementation(() => ({
    status: 0,
    stdout: [...rows].map(([pid, row]) => `p${pid}\0n${row.cwd ?? "/foreign"}\0\n`).join(""),
  }));
  darwinCommand.mockImplementation((pid: number) =>
    pid === 1
      ? { argvUnavailable: true, executable: "/sbin/launchd", uid: foreignUid }
      : { argv: rows.get(pid)!.argv },
  );
  expectPids([peer]);
  rows.delete(peer);
  rows.get(1)!.cwd = "/tmp/openclaw-plugin-build-abc123/package";
  expectPids([1]);
});

it("keeps Rosetta custody uncertain and names native arm64 Node.js for update repair", () => {
  processRow(peer, ["node", "/app/dist/index.js"]);
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
  expect(inspectOtherOpenClawProcesses(references).error).toBe(
    "Host process census is unavailable under Rosetta; run openclaw update repair with native arm64 Node.js.",
  );
});

function mockDarwinBatch(lsof: { status: number | null; stdout: string; error?: Error }) {
  processRow(launcher, ["node", "/app/openclaw.mjs", "doctor", "--fix"]);
  mockProcessPlatform("darwin");
  census.mockReturnValue(lsof);
  darwinCommand.mockImplementation((pid: number) => ({ argv: rows.get(pid)!.argv }));
}

it.each([peer, launcher, self])(
  "continues after an incomplete Darwin environment for PID %s",
  (incompletePid) => {
    processRow(peer, ["/bin/sleep", "60"]);
    processRow(peer + 1, ["node", "/app/dist/index.js"]);
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
  processRow(peer, ["node", "/vendor/worker.js"]);
  processRow(peer + 1, ["bun", "run", "--silent", "start"]);
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
])("retains processes after an incomplete cwd batch ($script)", ({ script, partial }) => {
  processRow(peer, ["node", script]);
  mockDarwinBatch(
    partial
      ? { status: 1, stdout: `p1\0n/\0` }
      : {
          status: null,
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          stdout: "",
        },
  );
  expectPids([peer], `PID ${peer}: working directory is unavailable`);
});

const references = { runId: "update-run-123", artifactPaths: ["/tmp/retained runtime"] };
const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });
function expectReferences(
  matchingPids: number[],
  unverifiedPids: number[] = [],
  handoff: typeof references & { sharedRoots?: string[]; familyDeadline?: number } = references,
) {
  expect(inspectOtherOpenClawProcesses(handoff)).toEqual({
    matchingPids,
    unverifiedPids,
    ...(unverifiedPids.length
      ? { warnings: unverifiedPids.map((pid) => expect.stringContaining(`PID ${pid}`)) }
      : {}),
  });
}

it.each([
  ["/usr/lib/systemd/systemd", "--user"],
  ["/usr/lib/systemd/systemd", "--user", "--deserialize=8"],
  ["/lib/systemd/systemd", "--user", "--deserialize=23"],
])("does not let protected systemd login processes block update-repair evidence: %j", (...argv) => {
  processRow(peer, argv, { uid: 1000, cwd: denied() });
  processRow(peer + 1, ["(sd-pam)"], { ppid: peer, uid: 1000, cwd: denied() });
  const handoffRefs = {
    runId: "systemd-update-run",
    artifactPaths: ["/tmp/openclaw-update-runtime-Ab1234"],
  };
  expectPids([]);
  expectReferences([], [], handoffRefs);
  rows.get(peer + 1)!.cwd = handoffRefs.artifactPaths[0];
  expectPids([peer + 1]);
  expectReferences([peer + 1], [], handoffRefs);
  rows.get(peer + 1)!.cwd = denied();
  rows.get(peer + 1)!.ppid = 1;
  expectPids([]);
  expectReferences([], [peer + 1], handoffRefs);
});

it.each([0, 1000])(
  "ignores unrelated non-runtime commands with unavailable cwd (UID %i)",
  (uid) => {
    processRow(peer, ["/bin/sh", "worker.sh"], { uid, cwd: denied() });
    expectPids([]);
    for (const startIdentity of ["99", "100", "101"]) {
      const handoff = { ...references, drivers: [{ pid: self, startIdentity }] };
      expectReferences([], uid === 1000 && startIdentity !== "101" ? [peer] : [], handoff);
    }
    rows.get(peer)!.argv.push(references.artifactPaths[0]!);
    expectReferences([peer], [], { ...references, drivers: [{ pid: self, startIdentity: "101" }] });
  },
);

it("finds orphaned handoff references while excluding only its verified updater launcher", () => {
  processRow(launcher, ["node", "/app/openclaw.mjs", "update", "repair", references.runId]);
  processRow(peer, ["node", "--run-id=update-run-123"]);
  processRow(peer + 1, ["node", "worker.js"], { cwd: "/tmp/retained runtime/tree" });
  processRow(peer + 2, ["node", "/tmp/retained runtime/tree/worker.js"]);
  processRow(peer + 3, [
    "node",
    "update-run-1234",
    "/tmp/retained runtime-other",
    "/tmp/retained runtime.old/worker.js",
  ]);
  processRow(peer + 4, ["node", "other-update-run-123", "/different/tmp/retained runtime"]);
  processRow(peer + 5, [
    "node",
    "--eval",
    'import("file:///tmp/retained%20runtime/tree/worker.js")',
  ]);
  expectReferences([peer, peer + 1, peer + 2, peer + 5]);
  processRow(launcher, ["openclaw-update", references.runId]);
  expect(inspectOtherOpenClawProcesses(references).matchingPids).toContain(launcher);
});

it.each(["linux", "darwin"] as const)(
  "checks readable handoff references before excluding opaque foreign %s processes",
  (platform) => {
    mockProcessPlatform(platform);
    processRow(peer, ["node", "worker.js"], { cwd: denied() });
    processRow(peer + 1, [], { uid: 2000, commandError: denied(), cwd: denied() });
    processRow(peer + 2, [], {
      uid: 2000,
      commandError: denied(),
      cwd: "/tmp/retained runtime/tree",
    });
    processRow(peer + 3, ["node", references.runId], { uid: 2000, cwd: denied() });
    if (platform === "darwin") {
      census.mockImplementation((_command: string, args: string[]) => {
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
    expectReferences([peer + 2, peer + 3], [peer]);
  },
);

it("names an unreadable same-user PID without exposing its process data", () => {
  processRow(peer, [], {
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
    processRow(peer, ["node", "worker.js"], { uid: 2000, cwd: denied() });
    const readFile = read.getMockImplementation()!;
    read.mockImplementation((file: string) =>
      file === `/proc/${peer}/status` ? `Uid:\t${uids}\n` : readFile(file),
    );
    expectReferences([], foreign ? [] : [peer]);
  },
);

it.each(["denied", "empty"])("preserves Doctor's refusal for foreign Linux %s argv", (kind) => {
  processRow(peer, [], {
    uid: 2000,
    ...(kind === "denied" ? { commandError: denied() } : {}),
  });
  expect(inspectOtherOpenClawProcesses()).toHaveProperty("error");
});

it("retains known matching PIDs when later inspection exhausts the census budget", () => {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  processRow(peer, ["node", references.runId]);
  processRow(peer + 1, ["node", "worker.js"]);
  processRow(peer + 2, ["node", "worker.js"]);
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

type Lineage = [pid: number, startedAtMs: number][];
function setLineage(stoppedBy: "root" | "through-pid" | "unreadable-parent", ...chains: Lineage[]) {
  const known = new Map(chains.map((chain) => [chain[0]![0], chain]));
  ancestry.mockImplementation((pid: number) => {
    const chain = known.get(pid);
    return chain
      ? {
          chain: chain.map(([member, startedAtMs], index) => ({
            pid: member,
            parentPid: chain[index + 1]?.[0] ?? 1,
            startTimeMicros: startedAtMs * 1000,
            startTimeResolutionMicros: 1,
            exited: false,
          })),
          complete: stoppedBy !== "unreadable-parent",
          stoppedBy,
        }
      : null;
  });
}

it("does not report the inspector's own descendants as handoff work", () => {
  processRow(peer, ["node", "/tmp/retained runtime/worker.js"], { ppid: self });
  processRow(peer + 1, ["node", "worker.js"], { ppid: peer, cwd: denied() });
  processRow(peer + 2, ["node", "/tmp/retained runtime/worker.js"]);
  processRow(peer + 3, ["node", "worker.js"], { cwd: denied() });
  setLineage(
    "through-pid",
    [
      [peer, 0],
      [self, 0],
    ],
    [
      [peer + 1, 0],
      [peer, 0],
      [self, 0],
    ],
  );
  expectReferences([peer + 2], [peer + 3]);
});

it("reports shared-root work unless its whole ancestry began after the family deadline", () => {
  const familyDeadline = 1_000_000;
  const after = familyDeadline + 1;
  const before = familyDeadline - 1;
  const installation = "/srv/openclaw";
  const candidate = `${installation}/.openclaw-update-child-candidate`;
  const manager = peer + 20;
  const shell = peer + 21;
  const gateway = ["node", `${installation}/openclaw.mjs`, "gateway", "run"];
  processRow(manager, ["/usr/lib/systemd/systemd", "--user"], { uid: 1000, cwd: "/" });
  processRow(shell, ["/usr/bin/tmux"], { cwd: "/home/operator" });
  processRow(peer, gateway);
  processRow(peer + 1, gateway);
  processRow(peer + 2, ["node", `${installation}/openclaw.mjs`, "--run-id=update-run-123"]);
  processRow(peer + 3, gateway, { ppid: shell });
  processRow(peer + 4, gateway, { ppid: manager });
  processRow(peer + 5, ["node", `${candidate}/openclaw.mjs`]);
  setLineage(
    "root",
    [[peer, after]],
    [[peer + 1, before]],
    [[peer + 2, after]],
    [
      [peer + 3, after],
      [shell, before],
    ],
    [
      [peer + 4, after],
      [manager, before],
    ],
    [[peer + 5, after]],
  );
  const handoff = {
    runId: references.runId,
    artifactPaths: [installation, candidate],
    sharedRoots: [`${installation}/`],
  };

  expectReferences([peer + 1, peer + 2, peer + 3, peer + 5], [], { ...handoff, familyDeadline });
  // Without a recorded deadline, or with an incomplete ancestry, every holder remains.
  const holders = [peer, peer + 1, peer + 2, peer + 3, peer + 4, peer + 5];
  expect(inspectOtherOpenClawProcesses(handoff).matchingPids).toEqual(holders);
  const complete = ancestry.getMockImplementation()!;
  ancestry.mockImplementation((pid: number) => ({
    ...complete(pid),
    stoppedBy: "unreadable-parent",
  }));
  expect(inspectOtherOpenClawProcesses({ ...handoff, familyDeadline }).matchingPids).toEqual(
    holders,
  );
});
