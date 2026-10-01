import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import type { inspectOtherOpenClawProcesses } from "../infra/openclaw-process-census.js";
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
    const lock = await acquireGatewayLock({
      env: ctx.env,
      role: "sqlite-maintenance",
      allowInTests: true,
    });
    if (!lock) {
      throw new Error("Expected Gateway maintenance ownership");
    }
    try {
      await lock.run(run);
    } finally {
      await lock.release();
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

it.each([
  { definition: "command", key: "TMPDIR" },
  { definition: "managed definition", key: "TEMP" },
])(
  "Doctor reports and cleans retained runtimes in the $definition $key from another shell",
  async ({ definition, key }) => {
    const serviceTmp = path.join(parent, "service-tmp");
    const directory = projection("Svc001", serviceTmp);
    mocks.serviceCommand.mockResolvedValue(
      definition === "command"
        ? { programArguments: [], environment: { [key]: serviceTmp } }
        : {
            programArguments: [],
            managedDefinition: {
              programArguments: [],
              workingDirectory: parent,
              environment: { [key]: "service-tmp" },
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

it("Doctor reclaims its marked projection when the source manifest is missing", async () => {
  const directory = projection("Edit01");
  fs.unlinkSync(path.join(packageRoot, "package.json"));
  const output = await runDoctor(true);
  expect(fs.existsSync(directory)).toBe(false);
  expect(output).toContain(`Removed abandoned updater runtime: ${directory}`);
});

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

it("Doctor warns instead of resolving service TMP against the shell cwd", async () => {
  mocks.serviceCommand.mockResolvedValue({
    programArguments: [],
    workingDirectory: "relative-service-cwd",
    environment: { TMP: "relative-scratch" },
  });
  expect(await runDoctor(true)).toContain("relative TMP without an absolute working directory");
});

it.each(["abandoned", "symlink", "bounded"])(
  "Doctor recognizes a legacy pnpm projection after the installed version changes (%s)",
  async (condition) => {
    const store = path.join(parent, "node_modules/.pnpm");
    const oldRoot = path.join(store, "openclaw@2026.9.5/node_modules/openclaw");
    fs.mkdirSync(path.dirname(oldRoot), { recursive: true });
    fs.renameSync(packageRoot, oldRoot);
    packageRoot = oldRoot;
    const directory = projection("Pnpm01");
    fs.rmSync(oldRoot, { recursive: true });
    packageRoot = path.join(store, "openclaw@2026.9.7/node_modules/openclaw");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
    mocks.packageRoots.mockReturnValue([packageRoot]);
    if (condition === "symlink") {
      const projectedStore = projectedPath(directory, store);
      const external = path.join(parent, "foreign-projection");
      fs.renameSync(projectedStore, external);
      fs.symlinkSync(external, projectedStore, process.platform === "win32" ? "junction" : "dir");
    }
    if (condition === "bounded") {
      const projectedStore = projectedPath(directory, store);
      fs.rmSync(path.join(projectedStore, "openclaw@2026.9.5"), { recursive: true });
      fs.mkdirSync(path.join(projectedStore, "unrelated-dependency"));
      const [entry] = fs.readdirSync(projectedStore, { withFileTypes: true });
      if (!entry) {
        throw new Error("expected a projected store entry");
      }
      const opendir = fsPromises.opendir.bind(fsPromises);
      vi.spyOn(fsPromises, "opendir").mockImplementation(async (...args) => {
        const handle = await opendir(...args);
        if (String(args[0]) === projectedStore) {
          vi.spyOn(handle, Symbol.asyncIterator).mockImplementation(
            async function* (): AsyncGenerator<fs.Dirent, undefined> {
              try {
                for (let index = 0; index < 4097; index++) {
                  yield entry;
                }
              } finally {
                await handle.close();
              }
            },
          );
        }
        return handle;
      });
    }
    const preview = await runDoctor(false);
    expect(fs.existsSync(directory)).toBe(true);
    if (condition === "abandoned") {
      expect(preview).toContain("openclaw doctor --fix");
    }
    mocks.note.mockClear();
    const output = await runDoctor(true);
    expect(fs.existsSync(directory)).toBe(condition !== "abandoned");
    expect(output).toContain(
      condition === "abandoned"
        ? `Removed abandoned updater runtime: ${directory}`
        : condition === "bounded"
          ? "exceeds the bounded lookup"
          : "no recognized runtime marker",
    );
  },
);

it.each([
  { scratch: "\\scratch", workingDirectory: "C:\\service", expected: "C:\\scratch" },
  { scratch: "C:scratch", workingDirectory: "C:\\service", expected: "C:\\service\\scratch" },
  { scratch: "D:scratch", workingDirectory: "C:\\service", expected: undefined },
])(
  "Doctor resolves the service's mixed-case Windows Temp without shell drive fallback ($scratch)",
  async ({ scratch, workingDirectory, expected }) => {
    const { inspectDoctorTemporaryDirectories } =
      await import("../commands/doctor/shared/temporary-directories.js");
    mocks.serviceCommand.mockResolvedValue({
      programArguments: [],
      workingDirectory,
      environment: { Temp: scratch },
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const result = await inspectDoctorTemporaryDirectories({ HOME: parent, TMPDIR: "Z:\\shell" });
    if (expected) {
      expect(result.directories).toContain(expected);
      expect(result.warnings).toEqual([]);
    } else {
      expect(result.directories.some((directory) => /^[dD]:/u.test(directory))).toBe(false);
      expect(result.warnings.join("\n")).toContain(
        "relative TEMP without an absolute working directory",
      );
    }
  },
);
