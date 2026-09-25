import fs from "node:fs";
import os from "node:os";
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

const mocks = vi.hoisted(() => ({
  note: vi.fn(),
  packageRoots: vi.fn<() => string[]>(),
  census: vi.fn<typeof inspectOtherOpenClawProcesses>(),
  serviceCommand: vi.fn<() => Promise<GatewayServiceCommandConfig | null>>(),
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: mocks.serviceCommand }),
}));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRootsSync: mocks.packageRoots,
}));
vi.mock("../infra/openclaw-process-census.js", () => ({
  inspectOtherOpenClawProcesses: mocks.census,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let parent: string;
let packageRoot: string;

beforeEach(() => {
  parent = fs.realpathSync(dirs.make("doctor-retained-runtime-"));
  packageRoot = path.join(parent, "checkout");
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
  mocks.packageRoots.mockReturnValue([packageRoot]);
  mocks.census.mockReturnValue({ pids: [] });
  mocks.serviceCommand.mockResolvedValue(null);
  vi.spyOn(os, "tmpdir").mockReturnValue(parent);
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.note.mockClear();
  mocks.packageRoots.mockReset();
  mocks.census.mockReset();
  mocks.serviceCommand.mockReset();
});

function projectedPath(directory: string, source: string): string {
  const base = path.parse(source).root;
  return path.join(
    directory,
    "tree",
    Buffer.from(base).toString("hex"),
    path.relative(base, source),
  );
}

function projection(suffix: string, root = parent): string {
  const directory = path.join(root, `openclaw-update-runtime-${suffix}`);
  const projectedRoot = projectedPath(directory, packageRoot);
  fs.mkdirSync(projectedRoot, { recursive: true });
  fs.copyFileSync(path.join(packageRoot, "package.json"), path.join(projectedRoot, "package.json"));
  return directory;
}

async function runDoctor(repair: boolean, maintenance = true): Promise<string> {
  const contributions = resolveDoctorHealthContributions().filter(
    (entry) => entry.id === "doctor:retained-update-runtimes",
  );
  const ctx = createDoctorHealthFlowContext({
    env: {
      HOME: parent,
      OPENCLAW_HOME: parent,
      OPENCLAW_STATE_DIR: path.join(parent, "state"),
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      TMPDIR: path.join(parent, "shell-tmp"),
    },
    options: { repair },
  });
  ctx.prompter.shouldRepair = repair;
  const run = () => runDoctorHealthContributionList(ctx, contributions);
  if (maintenance) {
    const lease = acquireGatewayMaintenanceCoordinator({
      databasePath: path.join(parent, "state/openclaw.sqlite"),
      runtimeDirectory: path.join(parent, "locks"),
    });
    const scope = createOpenClawDatabaseMaintenanceScope(lease.createSchemaFenceDelegate);
    try {
      await scope.run(run);
    } finally {
      await scope.close();
      lease.release();
    }
  } else {
    await run();
  }
  return mocks.note.mock.calls.map(([message]) => String(message)).join("\n");
}

it("Doctor removes an abandoned marked projection and releases checkout hardlinks", async () => {
  const abandoned = projection("Old001");
  const manifest = path.join(packageRoot, "extensions/discord/openclaw.plugin.json");
  const retainedManifest = projectedPath(abandoned, manifest);
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.mkdirSync(path.dirname(retainedManifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ id: "discord" }));
  fs.linkSync(manifest, retainedManifest);
  const preview = await runDoctor(false);
  expect(fs.existsSync(abandoned)).toBe(true);
  expect(fs.statSync(manifest).nlink).toBe(2);
  mocks.note.mockClear();
  const output = await runDoctor(true);
  expect(fs.existsSync(abandoned)).toBe(false);
  expect(fs.statSync(manifest).nlink).toBe(1);
  expect(fs.readFileSync(manifest, "utf8")).toBe('{"id":"discord"}');
  expect(preview).toContain("openclaw doctor --fix");
  expect(output).toContain(`Removed abandoned updater runtime: ${abandoned}`);
});

it.each(["command", "managed definition"])(
  "Doctor reports and cleans retained runtimes in the %s TMPDIR from another shell",
  async (definition) => {
    const serviceTmp = path.join(parent, "service-tmp");
    const directory = projection("Svc001", serviceTmp);
    mocks.serviceCommand.mockResolvedValue(
      definition === "command"
        ? { programArguments: [], environment: { TMPDIR: serviceTmp } }
        : {
            programArguments: [],
            managedDefinition: {
              programArguments: [],
              workingDirectory: parent,
              environment: { TMPDIR: "service-tmp" },
            },
          },
    );
    const preview = await runDoctor(false);
    expect(fs.existsSync(directory)).toBe(true);
    expect(preview).toContain(`Runtime retained at ${directory}:`);
    mocks.note.mockClear();
    const output = await runDoctor(true);
    expect(fs.existsSync(directory)).toBe(false);
    expect(output).toContain(`Removed abandoned updater runtime: ${directory}`);
  },
);

it("Doctor warns about service inspection failure while reclaiming a known runtime", async () => {
  const directory = projection("Svc002");
  mocks.serviceCommand.mockRejectedValue(new Error("fixture service inspection unavailable"));
  const output = await runDoctor(true);
  expect(fs.existsSync(directory)).toBe(false);
  expect(output).toContain(`Removed abandoned updater runtime: ${directory}`);
  expect(output).toContain("Could not inspect the managed service temporary directory");
  expect(output).toContain("fixture service inspection unavailable");
});

it("Doctor does not search unrelated checkout ancestors", async () => {
  const original = packageRoot;
  packageRoot = path.join(parent, "group/inner/checkout");
  fs.mkdirSync(path.dirname(packageRoot), { recursive: true });
  fs.renameSync(original, packageRoot);
  mocks.packageRoots.mockReturnValue([packageRoot]);
  const directory = projection("Else01", path.join(parent, "group"));
  const output = await runDoctor(true);
  expect(fs.existsSync(directory)).toBe(true);
  expect(output).not.toContain(directory);
});

it.each(["changed", "missing"])(
  "Doctor reclaims its marked projection when source bytes are %s",
  async (source) => {
    const directory = projection("Edit01");
    const manifest = path.join(packageRoot, "package.json");
    if (source === "missing") {
      fs.unlinkSync(manifest);
    } else {
      fs.writeFileSync(manifest, JSON.stringify({ name: "openclaw", changed: true }));
    }
    const output = await runDoctor(true);
    expect(fs.existsSync(directory)).toBe(false);
    expect(output).toContain(`Removed abandoned updater runtime: ${directory}`);
  },
);

it("Doctor preserves a runtime still registered by its creator", async () => {
  const { registerRetainedUpdateRuntime } = await import("../infra/temp-artifact-cleanup.js");
  const active = projection("Live01");
  const release = registerRetainedUpdateRuntime(active);
  try {
    const output = await runDoctor(true);
    expect(fs.existsSync(active)).toBe(true);
    expect(output).toContain(
      `Runtime retained at ${active}: the creating update still owns this runtime`,
    );
  } finally {
    release();
  }
});

it.each([
  { reason: "Doctor does not hold Gateway maintenance", maintenance: false, census: { pids: [] } },
  { reason: "PIDs: 4242", maintenance: true, census: { pids: [4242] } },
  {
    reason: "fixture census unavailable",
    maintenance: true,
    census: { error: "fixture census unavailable" },
  },
])("Doctor preserves a projection when $reason", async ({ reason, maintenance, census }) => {
  const directory = projection("Old002");
  mocks.census.mockReturnValue(census);
  const output = await runDoctor(true, maintenance);
  expect(fs.existsSync(directory)).toBe(true);
  expect(output).toContain(`Runtime retained at ${directory}:`);
  expect(output).toContain(reason);
  expect(output).not.toContain("Removed abandoned updater runtime");
});

it("Doctor preserves unmarked directories and symbolic-link targets", async () => {
  const foreign = path.join(parent, "openclaw-update-runtime-Odd001");
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, "operator-data"), "preserve");
  const link = path.join(parent, "openclaw-update-runtime-Link01");
  fs.symlinkSync(packageRoot, link, process.platform === "win32" ? "junction" : "dir");
  const output = await runDoctor(true);
  expect(fs.readFileSync(path.join(foreign, "operator-data"), "utf8")).toBe("preserve");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(output).toContain("no recognized runtime marker");
  expect(output).toContain("directory ownership is unknown");
});
