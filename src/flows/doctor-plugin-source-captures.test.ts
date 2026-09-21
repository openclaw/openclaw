import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import type { inspectOtherOpenClawProcesses } from "../infra/openclaw-process-census.js";
import { acquireGatewayMaintenanceCoordinator } from "../infra/state-database-coordinator.js";
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
  vi.unstubAllEnvs();
  note.mockClear();
  readCommand.mockReset();
  census.mockReset();
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
  const lease = acquireGatewayMaintenanceCoordinator({
    databasePath: path.join(stateDir, "openclaw.sqlite"),
    runtimeDirectory: path.join(parent, "locks"),
  });
  const scope = createOpenClawDatabaseMaintenanceScope(lease.createSchemaFenceDelegate);
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

it.each([false, true])(
  "reports environment, system, and recorded service temporary directories (update=%s)",
  async (update) => {
    const serviceTmp = path.join(parent, "service-tmp");
    write(environmentTmp, "openclaw-plugin-build-env/source.cjs", "abc");
    write(systemTmp, "openclaw-plugin-build-system/source.cjs", "12345");
    write(serviceTmp, "openclaw-plugin-build-service/source.cjs", "1234567");
    const homeTmp = path.join(parent, ".openclaw", "tmp");
    write(homeTmp, "openclaw-plugin-build-home/source.cjs", "ab");
    readCommand.mockResolvedValue({ programArguments: [], environment: { TMPDIR: serviceTmp } });

    const output = await runCaptureReport(false, update);
    expect(output).toContain("4 legacy plugin capture root(s), 17 B");
    for (const directory of [environmentTmp, systemTmp, serviceTmp, homeTmp]) {
      expect(output).toContain(directory);
    }
    expect(output).toContain("They will be reclaimed at the next maintenance.");
    expect(census).not.toHaveBeenCalled();
  },
);

it.each([
  { mode: "read-only", repair: false, maintenance: true, peers: [], reason: "next maintenance" },
  {
    mode: "outside maintenance",
    repair: true,
    maintenance: false,
    peers: [],
    reason: "does not hold Gateway maintenance",
  },
  { mode: "live sibling", repair: true, maintenance: true, peers: [4242], reason: "PIDs: 4242" },
  {
    mode: "unavailable census",
    repair: true,
    maintenance: true,
    peers: [],
    reason: "fixture census unavailable",
  },
])("preserves legacy captures with $mode", async ({ mode, repair, maintenance, peers, reason }) => {
  const file = write(systemTmp, "openclaw-plugin-build-legacy/source.cjs", "captured source");
  inspectAsLaterProcess();
  census.mockReturnValue(mode === "unavailable census" ? { error: reason } : { pids: peers });

  const output = maintenance
    ? await duringMaintenance(() => runCaptureReport(repair))
    : await runCaptureReport(repair);
  expect(output).toContain(reason);
  expect(output).not.toContain("Removed ");
  expect(fs.readFileSync(file, "utf8")).toBe("captured source");
});

it("reclaims only tokenless capture roots and prints a receipt after successful removal", async () => {
  const tmp = path.join(stateDir, "tmp");
  const plugin = write(tmp, "openclaw-plugin-build-old/source.cjs", "abc");
  write(tmp, "openclaw-plugin-build-old/nested/module.cjs", "defg");
  const catalog = write(systemTmp, "openclaw-model-catalog-old/catalog.cjs", "12345");
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
  expect(output).toContain("2 legacy plugin capture root(s), 12 B");
  expect(output).toContain("Removed 2 legacy plugin capture root(s), 12 B.");
  for (const file of [plugin, catalog]) {
    expect(output).toContain(`Removed ${path.dirname(file)} (`);
    expect(fs.existsSync(file)).toBe(false);
  }
  for (const preserved of [managed, token, nested, ordinaryFile, outside]) {
    expect(fs.existsSync(preserved), preserved).toBe(true);
  }
  expect(fs.lstatSync(path.join(tmp, "openclaw-plugin-build-link")).isSymbolicLink()).toBe(true);
});

it("preserves captures created during the current process even while maintenance is held", async () => {
  const file = write(systemTmp, "openclaw-plugin-build-current/source.cjs", "still owned");
  const output = await duringMaintenance(() => runCaptureReport(true));
  expect(output).toContain("created or changed during the current process");
  expect(output).not.toContain("Removed ");
  expect(fs.readFileSync(file, "utf8")).toBe("still owned");
});

it("rechecks the host census immediately before deletion", async () => {
  const file = write(systemTmp, "openclaw-plugin-build-legacy/source.cjs", "retained");
  inspectAsLaterProcess();
  census.mockReturnValueOnce({ pids: [] }).mockReturnValue({ pids: [4343] });
  const output = await duringMaintenance(() => runCaptureReport(true));
  expect(output).toContain("PIDs: 4343");
  expect(output).not.toContain("Removed ");
  expect(fs.readFileSync(file, "utf8")).toBe("retained");
});

it("preserves a capture whose nested file changed after reporting while its root stayed old", async () => {
  const file = write(systemTmp, "openclaw-plugin-build-legacy/nested/source.cjs", "current bytes");
  const capture = path.dirname(path.dirname(file));
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

  const output = await duringMaintenance(() => runCaptureReport(true));
  expect(output).toContain("created or changed during the current process");
  expect(output).not.toContain("Removed ");
  expect(fs.readFileSync(file, "utf8")).toBe("current bytes");
});

it("deduplicates temporary directory aliases without following capture symlinks", async () => {
  const tmp = path.join(stateDir, "tmp");
  fs.mkdirSync(stateDir);
  fs.symlinkSync(systemTmp, tmp, "junction");
  const file = write(systemTmp, "openclaw-plugin-build-old/source.cjs", "content");
  readCommand.mockResolvedValue({ programArguments: [], environment: { TMPDIR: tmp } });
  const output = await runCaptureReport();
  expect(output).toContain("1 legacy plugin capture root(s), 7 B");
  expect(fs.readFileSync(file, "utf8")).toBe("content");
});

it("records removal failures without claiming a successful receipt", async () => {
  const file = write(systemTmp, "openclaw-plugin-build-legacy/source.cjs", "retained");
  inspectAsLaterProcess();
  const remove = fsPromises.rm.bind(fsPromises);
  vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
    if (target === path.dirname(file)) {
      throw Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
    }
    await remove(target, options);
  });
  const output = await duringMaintenance(() => runCaptureReport(true));
  expect(output).toContain("Could not remove");
  expect(output).not.toContain("Removed ");
  expect(fs.readFileSync(file, "utf8")).toBe("retained");
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
