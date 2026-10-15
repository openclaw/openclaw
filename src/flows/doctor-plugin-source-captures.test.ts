import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import type { inspectOtherOpenClawProcesses } from "../infra/openclaw-process-census.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

const { note, readCommand, census, processMembers, ps, readProcessCommand } = vi.hoisted(() => ({
  note: vi.fn(),
  readCommand: vi.fn<() => Promise<GatewayServiceCommandConfig | null>>(),
  census: vi.fn<typeof inspectOtherOpenClawProcesses>(),
  processMembers: vi.fn(),
  ps: vi.fn(),
  readProcessCommand: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: ps,
}));
vi.mock("@openclaw/proc-safe/inspect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/proc-safe/inspect")>()),
  readProcessCommand,
}));
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/proc-safe/identity")>();
  return {
    ...actual,
    readProcessIdentity: (pid: number) =>
      pid === 2_000_000_000
        ? {
            pid,
            parentPid: process.pid,
            startTimeMicros: 1,
            startTimeResolutionMicros: 1,
            exited: false,
          }
        : actual.readProcessIdentity(pid),
  };
});
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand }),
}));
vi.mock("../infra/openclaw-process-census.js", () => ({
  inspectOtherOpenClawProcesses: census,
}));
vi.mock("../process/supervisor/service-child-group-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../process/supervisor/service-child-group-ownership.js")
  >()),
  readProcessGroupMembers: processMembers,
}));

const temp = useAutoCleanupTempDirTracker(afterEach);
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
let parent: string;
let stateDir: string;
let environmentTmp: string;
let systemTmp: string;

beforeEach(() => {
  parent = fs.realpathSync(temp.make("doctor-plugin-captures-"));
  stateDir = path.join(parent, "state");
  environmentTmp = path.join(parent, "environment-tmp");
  systemTmp = path.join(parent, "system-tmp");
  for (const directory of [environmentTmp, systemTmp]) {
    fs.mkdirSync(directory);
  }
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, environmentTmp);
  }
  // Exercise literal /tmp discovery without inspecting or deleting the host's real scratch.
  const realpath = fsPromises.realpath.bind(fsPromises);
  vi.spyOn(fsPromises, "realpath").mockImplementation(async (target) =>
    realpath(String(target) === "/tmp" ? systemTmp : target),
  );
  readCommand.mockResolvedValue(null);
  census.mockReturnValue({ pids: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (getuidDescriptor) {
    Object.defineProperty(process, "getuid", getuidDescriptor);
  } else {
    Reflect.deleteProperty(process, "getuid");
  }
  vi.unstubAllEnvs();
  note.mockClear();
  readCommand.mockReset();
  census.mockReset();
  processMembers.mockReset();
  ps.mockReset();
  readProcessCommand.mockReset();
});

async function runCaptureReport(repair = false, update = false) {
  const contribution = resolveDoctorHealthContributions().find(
    (entry) => entry.id === "doctor:legacy-plugin-source-captures",
  );
  expect(contribution, "capture cleanup must be registered with Doctor").toBeDefined();
  const ctx = createDoctorHealthFlowContext({
    env: {
      HOME: parent,
      OPENCLAW_HOME: parent,
      OPENCLAW_STATE_DIR: stateDir,
      ...(update ? { OPENCLAW_UPDATE_IN_PROGRESS: "1" } : {}),
    },
    options: { repair },
  });
  ctx.prompter.shouldRepair = repair;
  if (update) {
    await runDoctorHealthContributionList(ctx, [contribution!]);
  } else {
    await contribution!.run(ctx);
  }
  return note.mock.calls.map(([message]) => String(message)).join("\n");
}

async function duringMaintenance(run: () => Promise<string>) {
  const lease = acquireGatewayStateOwner({
    databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
  });
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: lease.assertCurrent,
    assertDatabaseAccess: lease.assertDatabaseAccess,
  });
  try {
    return await scope.run(run);
  } finally {
    await scope.close();
    lease.release();
  }
}

function write(root: string, filename: string, contents: string) {
  const file = path.join(root, filename);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function inspectAsLaterProcess() {
  // The fixtures model captures left by an earlier process, without sleeps or backdated files.
  vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(Date.now() + 1_000);
}

it.each([
  { sameUid: false, foreignCapture: false, removed: true },
  { sameUid: true, foreignCapture: false, removed: false },
  { sameUid: false, foreignCapture: true, removed: false },
])(
  "repairs legacy captures through Darwin's unreadable-argv census (same UID=$sameUid, foreign capture=$foreignCapture)",
  async ({ sameUid, foreignCapture, removed }) => {
    mockProcessPlatform("darwin");
    const uid = fs.statSync(parent).uid;
    Object.defineProperty(process, "getuid", { configurable: true, value: () => uid });
    const peer = 2_000_000_000;
    const file = write(systemTmp, "openclaw-plugin-build-legacy/source.cjs", "capture");
    if (foreignCapture) {
      const lstat = fsPromises.lstat.bind(fsPromises);
      vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, options) => {
        const stat = await lstat(target, options);
        if (target === path.dirname(file)) {
          Object.assign(stat, { uid: uid + 1 });
        }
        return stat;
      });
    }
    inspectAsLaterProcess();
    ps.mockReturnValue({
      status: 0,
      stdout: `${process.pid} ${process.pid} S 0 ${uid}\n${peer} ${peer} S 0 ${sameUid ? uid : uid + 1}\n`,
    });
    readProcessCommand.mockImplementation((pid: number) => {
      if (pid === peer) {
        throw new ProcSafeError("access-denied", "Process arguments denied");
      }
      return { executable: "/node", argv: ["/node", "openclaw-doctor"], environment: {} };
    });
    const group = await vi.importActual<
      typeof import("../process/supervisor/service-child-group-ownership.js")
    >("../process/supervisor/service-child-group-ownership.js");
    processMembers.mockImplementation(group.readProcessGroupMembers);
    const actual = await vi.importActual<typeof import("../infra/openclaw-process-census.js")>(
      "../infra/openclaw-process-census.js",
    );
    census.mockImplementation(actual.inspectOtherOpenClawProcesses);
    // Match the native identity fixture: neither liveness path may bypass argv handling.
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) =>
      pid === peer && signal === 0 ? true : kill(pid, signal),
    );
    const output = await duringMaintenance(() => runCaptureReport(true));
    expect(fs.existsSync(file)).toBe(!removed);
    expect(output).toContain(
      sameUid
        ? `Could not classify PID ${peer}`
        : foreignCapture
          ? "owned by another UID"
          : "Removed 1 legacy plugin capture root(s)",
    );
    if (!removed) {
      expect(output).not.toContain("Removed ");
      expect(fs.readFileSync(file, "utf8")).toBe("capture");
    }
  },
);

it("reports distinct temporary directories during update and deduplicates aliases", async () => {
  const serviceTmp = path.join(parent, "service-tmp");
  write(environmentTmp, "openclaw-plugin-build-env/source.cjs", "abc");
  const systemFile = write(systemTmp, "openclaw-plugin-build-system/source.cjs", "12345");
  write(serviceTmp, "openclaw-plugin-build-service/source.cjs", "1234567");
  const homeTmp = path.join(parent, ".openclaw", "tmp");
  write(homeTmp, "openclaw-plugin-build-home/source.cjs", "ab");
  fs.mkdirSync(stateDir);
  fs.symlinkSync(systemTmp, path.join(stateDir, "tmp"), "junction");
  readCommand.mockResolvedValue({ programArguments: [], environment: { TMPDIR: serviceTmp } });

  const output = await runCaptureReport(false, true);
  expect(output).toContain("4 legacy plugin capture root(s), 17 B");
  for (const directory of [environmentTmp, systemTmp, serviceTmp, homeTmp]) {
    expect(output).toContain(directory);
  }
  expect(output).toContain("They will be reclaimed at the next maintenance.");
  expect(census).not.toHaveBeenCalled();
  expect(fs.readFileSync(systemFile, "utf8")).toBe("12345");
});

it.each([
  { mode: "outside maintenance", reason: "does not hold Gateway maintenance" },
  { mode: "live sibling", reason: "PIDs: 4242" },
  { mode: "sibling appeared after inspection", reason: "PIDs: 4343" },
  { mode: "nested file changed", reason: "created or changed during the current process" },
  { mode: "removal failed", reason: "Could not remove" },
])("preserves legacy captures without a removal receipt when $mode", async ({ mode, reason }) => {
  const capture = path.join(systemTmp, "openclaw-plugin-build-legacy");
  const file = write(capture, "nested/source.cjs", "captured source");
  if (mode === "nested file changed") {
    const lstat = fsPromises.lstat.bind(fsPromises);
    let fileReads = 0;
    vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, options) => {
      const stat = await lstat(target, options);
      if (
        target === capture ||
        target === path.dirname(file) ||
        (target === file && fileReads++ === 0)
      ) {
        Object.assign(stat, { birthtimeMs: 1, ctimeMs: 1 });
      }
      return stat;
    });
  } else {
    inspectAsLaterProcess();
  }
  if (mode === "live sibling") {
    census.mockReturnValue({ pids: [4242] });
  } else if (mode === "sibling appeared after inspection") {
    census.mockReturnValueOnce({ pids: [] }).mockReturnValue({ pids: [4343] });
  } else if (mode === "removal failed") {
    const remove = fsPromises.rm.bind(fsPromises);
    vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (target === capture) {
        throw Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
      }
      await remove(target, options);
    });
  }
  const output =
    mode === "outside maintenance"
      ? await runCaptureReport(true)
      : await duringMaintenance(() => runCaptureReport(true));
  expect(output).toContain(reason);
  expect(output).not.toContain("Removed ");
  expect(fs.readFileSync(file, "utf8")).toBe("captured source");
});

it("reclaims only tokenless capture roots and prints a receipt after successful removal", async () => {
  const tmp = path.join(stateDir, "tmp");
  const plugin = write(tmp, "openclaw-plugin-build-old/source.cjs", "abc");
  write(tmp, "openclaw-plugin-build-old/nested/module.cjs", "defg");
  const catalogRoot = path.join(systemTmp, "openclaw-model-catalog-old");
  const catalog = write(catalogRoot, "openclaw-plugin-build-one/package-0/source.cjs", "12345");
  const second = write(catalogRoot, "openclaw-plugin-build-two/package-0/source.cjs", "678");
  const managed = write(tmp, "plugin-captures/owner/captures/source.cjs", "managed");
  const token = write(systemTmp, "openclaw-plugin-build-modern/owner.sqlite", "custody");
  const nested = write(tmp, "unrelated/openclaw-plugin-build-nested/source.cjs", "nested");
  const ordinaryFile = write(tmp, "openclaw-plugin-build-file", "ordinary");
  const outside = write(parent, "outside/sentinel", "x".repeat(1024));
  fs.symlinkSync(path.dirname(outside), path.join(tmp, "openclaw-plugin-build-link"), "junction");
  fs.symlinkSync(path.dirname(outside), path.join(path.dirname(plugin), "external"), "junction");
  fs.symlinkSync(path.dirname(plugin), path.join(path.dirname(plugin), "cycle"), "junction");
  inspectAsLaterProcess();

  const output = await duringMaintenance(() => runCaptureReport(true));
  expect(output).toContain("2 legacy plugin capture root(s), 15 B");
  expect(output).toContain("Removed 2 legacy plugin capture root(s), 15 B.");
  for (const root of [path.dirname(plugin), catalogRoot]) {
    expect(output).toContain(`Removed ${root} (`);
  }
  for (const file of [plugin, catalog, second]) {
    expect(fs.existsSync(file)).toBe(false);
  }
  for (const preserved of [managed, token, nested, ordinaryFile, outside]) {
    expect(fs.existsSync(preserved), preserved).toBe(true);
  }
  expect(fs.lstatSync(path.join(tmp, "openclaw-plugin-build-link")).isSymbolicLink()).toBe(true);
});

it("keeps inspection errors advisory and empty temporary directories silent", async () => {
  await runCaptureReport();
  expect(note).not.toHaveBeenCalled();
  readCommand.mockRejectedValue(new Error("fixture service inspection unavailable"));
  const readdir = fsPromises.readdir.bind(fsPromises);
  vi.spyOn(fsPromises, "readdir").mockImplementation(async (target, options) => {
    if (target === systemTmp) {
      throw Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
    }
    return readdir(target, options);
  });
  const output = await runCaptureReport(true);
  expect(output).toContain("inspection or cleanup was incomplete");
  expect(output).toContain("fixture service inspection unavailable");
  expect(output).toContain("fixture permission denied");
  expect(output).not.toContain("Removed ");
});
