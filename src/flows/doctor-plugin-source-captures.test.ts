import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import type { inspectOtherOpenClawProcesses } from "../infra/openclaw-process-census.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

const { note, readCommand, census } = vi.hoisted(() => ({
  note: vi.fn(),
  readCommand: vi.fn<() => Promise<GatewayServiceCommandConfig | null>>(),
  census: vi.fn<typeof inspectOtherOpenClawProcesses>(),
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand }),
}));
vi.mock("../infra/openclaw-process-census.js", () => ({
  inspectOtherOpenClawProcesses: census,
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
  vi.resetAllMocks();
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

function mockStats(rewrite: (target: fs.PathLike) => object) {
  const lstat = fsPromises.lstat.bind(fsPromises);
  vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, options) =>
    Object.assign(await lstat(target, options), rewrite(target)),
  );
}

function capture(filename: string, contents = "capture", root = systemTmp) {
  return write(root, `openclaw-plugin-build-${filename}`, contents);
}

// Native argv/UID classification is covered by darwin-process-command.test.ts
// and openclaw-process-census.test.ts; this layer verifies refusal reaches cleanup.
it("reports distinct temporary directories during update and deduplicates aliases", async () => {
  const serviceTmp = path.join(parent, "service-tmp");
  capture("env/source.cjs", "abc", environmentTmp);
  const systemFile = capture("system/source.cjs", "12345");
  capture("service/source.cjs", "1234567", serviceTmp);
  const homeTmp = path.join(parent, ".openclaw", "tmp");
  capture("home/source.cjs", "ab", homeTmp);
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
  { mode: "unreadable census", reason: "Could not classify PID 4242" },
  { mode: "foreign UID", reason: "owned by another UID" },
  { mode: "live sibling", reason: "PIDs: 4242" },
  { mode: "sibling appeared after inspection", reason: "PIDs: 4343" },
  { mode: "nested file changed", reason: "created or changed during the current process" },
  { mode: "removal failed", reason: "Could not remove" },
])("preserves legacy captures without a removal receipt when $mode", async ({ mode, reason }) => {
  const captureRoot = path.join(systemTmp, "openclaw-plugin-build-legacy");
  const file = write(captureRoot, "nested/source.cjs", "captured source");
  if (mode === "nested file changed") {
    let fileReads = 0;
    mockStats((target) =>
      target === captureRoot ||
      target === path.dirname(file) ||
      (target === file && fileReads++ === 0)
        ? { birthtimeMs: 1, ctimeMs: 1 }
        : {},
    );
  } else {
    inspectAsLaterProcess();
  }
  if (mode === "foreign UID") {
    const uid = fs.statSync(parent).uid;
    Object.defineProperty(process, "getuid", { configurable: true, value: () => uid });
    mockStats((target) => (target === captureRoot ? { uid: uid + 1 } : {}));
  } else if (mode === "unreadable census") {
    census.mockReturnValue({ error: "Could not classify PID 4242" });
  } else if (mode === "live sibling") {
    census.mockReturnValue({ pids: [4242] });
  } else if (mode === "sibling appeared after inspection") {
    census.mockReturnValueOnce({ pids: [] }).mockReturnValue({ pids: [4343] });
  } else if (mode === "removal failed") {
    const remove = fsPromises.rm.bind(fsPromises);
    vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (target === captureRoot) {
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
  const plugin = capture("old/source.cjs", "abc", tmp);
  capture("old/nested/module.cjs", "defg", tmp);
  const catalogRoot = path.join(systemTmp, "openclaw-model-catalog-old");
  const catalog = capture("one/package-0/source.cjs", "12345", catalogRoot);
  const second = capture("two/package-0/source.cjs", "678", catalogRoot);
  const managed = write(tmp, "plugin-captures/owner/captures/source.cjs", "managed");
  const token = capture("modern/owner.sqlite", "custody");
  const nested = write(tmp, "unrelated/openclaw-plugin-build-nested/source.cjs", "nested");
  const ordinaryFile = capture("file", "ordinary", tmp);
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
