import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { UpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as runtimePaths from "../daemon/runtime-paths.js";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as tmpOpenClawDir from "../infra/tmp-openclaw-dir.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import type { prepareGitCandidateNodeRuntime } from "../infra/update-runner-git-node-preflight.js";
import { snapshotPreflightSourceManifest } from "../state/openclaw-database-preflight.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertNodeRuntimeUpdateCompatible } from "./auto-update-compatibility.js";
import { prepareNodeRuntimeUpdate } from "./auto-update-install.js";
import {
  nodeUpdateMetadata,
  useNodeUpdateRuntime,
  writeNodeUpdateCandidate,
} from "./auto-update.test-support.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  pack: vi.fn(),
  command: vi.fn(),
  assertCurrent: vi.fn(),
  nodeRuntime: vi.fn<typeof prepareGitCandidateNodeRuntime>(),
}));

vi.mock("../cli/update-cli/update-command-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/update-cli/update-command-executor.js")>()),
  withUpdateCommandExecutor: async (
    _runId: string,
    operation: (executor: UpdateCommandExecutor) => Promise<unknown>,
  ) => operation({ enter: async () => ({ assertCurrent: mocks.assertCurrent }) }),
}));
vi.mock("../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata: mocks.resolve,
  packNpmSpecToArchive: mocks.pack,
}));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: mocks.command,
}));
vi.mock("../infra/update-runner-git-node-preflight.js", () => ({
  prepareGitCandidateNodeRuntime: mocks.nodeRuntime,
}));
vi.mock("../state/openclaw-database-preflight.js", () => ({
  preflightOpenClawDatabaseSchemas: async () => ({ incompatible: [], indeterminate: [] }),
}));

const VERSION = nodeUpdateMetadata.version;
const metadata: NpmSpecResolution = nodeUpdateMetadata;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const prepare = (stateDir: string) =>
  prepareNodeRuntimeUpdate({ targetVersion: VERSION, stateDir });
const readPackage = async (root: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

function expectNoNpm() {
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.pack).not.toHaveBeenCalled();
}

async function writeCandidate(packageRoot: string, version = VERSION): Promise<void> {
  await writeNodeUpdateCandidate(packageRoot, version);
  await writePackageDistInventory(packageRoot);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nodeRuntime.mockResolvedValue({ env: {} });
  mocks.resolve.mockResolvedValue({ ok: true, metadata });
  mocks.pack.mockImplementation(async ({ cwd }: { cwd: string }) => {
    const archivePath = path.join(cwd, "openclaw.tgz");
    await fs.writeFile(archivePath, "synthetic npm archive");
    return { ok: true, archivePath, metadata };
  });
  mocks.command.mockImplementation(async (argv: string[]) => {
    if (argv.at(-1) === "--version") {
      return { code: 0, stdout: "12.0.0\n", stderr: "" };
    }
    const prefixIndex = argv.indexOf("--prefix");
    const prefix = argv[prefixIndex + 1];
    if (argv.includes("i") && prefixIndex >= 0 && prefix) {
      const layout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
      await writeCandidate(path.join(layout.globalRoot, "openclaw"));
      return { code: 0, stdout: "installed", stderr: "" };
    }
    throw new Error(`Unexpected external command: ${argv.join(" ")}`);
  });
});
describe("candidate node runtime and database compatibility", () => {
  useNodeUpdateRuntime();
  let fixture: Awaited<ReturnType<typeof createCompatibilityFixture>>;
  beforeEach(async () => {
    fixture = await createCompatibilityFixture(tempDirs.make("openclaw-node-compat-"));
  });
  afterEach(() => vi.restoreAllMocks());
  function preflightResult(kind: "state" | "agent", status = "exact", code = 0, reason?: string) {
    return {
      code,
      stdout: JSON.stringify({ schema: `openclaw.${kind}-schema-preflight.v1`, status, reason }),
      stderr: "",
    };
  }

  async function createCompatibilityFixture(directory: string) {
    const stateDir = path.join(directory, "node-state");
    const packageRoot = path.join(directory, "candidate");
    await writeNodeUpdateCandidate(packageRoot);
    const statePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    using database = new DatabaseSync(statePath);
    database.exec("CREATE TABLE agent_databases (agent_id TEXT, path TEXT);");
    database
      .prepare("INSERT INTO agent_databases VALUES (?, ?)")
      .run("removed", "removed-agent.sqlite");
    return { stateDir, packageRoot, statePath };
  }

  describe("candidate node runtime compatibility", () => {
    it.each([
      { runtime: "renamed Node", accepted: true },
      { runtime: "Node", accepted: false },
      { runtime: "Bun", accepted: true },
    ])("checks the candidate against its $runtime host", async ({ runtime, accepted }) => {
      const system =
        runtime === "renamed Node"
          ? vi.spyOn(runtimePaths, "resolveSystemNodeInfo").mockResolvedValue(null)
          : undefined;
      Object.defineProperty(process, "versions", {
        value: {
          ...process.versions,
          node: runtime === "renamed Node" ? "26.12.1" : process.versions.node,
          bun: runtime === "Bun" ? "1.4.3" : undefined,
        },
      });
      if (runtime === "renamed Node") {
        const { prepareGitCandidateNodeRuntime: prepareRuntime } = await vi.importActual<
          typeof import("../infra/update-runner-git-node-preflight.js")
        >("../infra/update-runner-git-node-preflight.js");
        mocks.nodeRuntime.mockImplementation(prepareRuntime);
        vi.stubEnv("PATH", "");
        Object.defineProperty(process, "execPath", { value: path.resolve("fixture", "node26") });
      } else {
        mocks.nodeRuntime.mockResolvedValue({
          step: {
            name: "preflight-node-runtime",
            command: "check Node",
            cwd: "/fixture",
            durationMs: 0,
            exitCode: 1,
            stderrTail: "No system Node was found.",
          },
        });
      }
      await fs.rm(fixture.statePath);
      const compatible = assertNodeRuntimeUpdateCompatible(fixture);
      await (accepted
        ? expect(compatible).resolves.toBeUndefined()
        : expect(compatible).rejects.toThrow("No system Node was found."));
      if (runtime === "renamed Node") {
        expect(system).not.toHaveBeenCalled();
      }
    });
  });

  describe("candidate node database compatibility", () => {
    it("consolidates committed state and agent WAL rows without changing their live families", async () => {
      const { DatabaseSync } = requireNodeSqlite();
      using state = new DatabaseSync(fixture.statePath);
      const agentPath = path.join(fixture.stateDir, "agent.sqlite");
      using agent = new DatabaseSync(agentPath);
      for (const writer of [state, agent]) {
        writer.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            CREATE TABLE wal_probe (value TEXT);
            INSERT INTO wal_probe VALUES ('discard'), ('committed-wal');
            DELETE FROM wal_probe WHERE rowid = 1;
          `);
      }
      state.prepare("INSERT INTO agent_databases VALUES (?, ?)").run("active", agentPath);
      const before = snapshotPreflightSourceManifest(fixture.stateDir);
      const stateEntries = await fs.readdir(path.dirname(fixture.statePath));
      const copiedPaths: string[] = [];
      mocks.command.mockImplementation(async (argv: string[]) => {
        const commandIndex = argv.indexOf("database");
        const kind = copiedPaths.length === 0 ? "state" : "agent";
        expect(argv.slice(0, commandIndex + 2)).toEqual([
          process.execPath,
          ...(process.versions.bun ? ["--no-install"] : []),
          path.join(fixture.packageRoot, "openclaw.mjs"),
          "database",
          kind === "state" ? "preflight" : "preflight-agent",
        ]);
        const copiedPath = argv[commandIndex + 2] ?? "";
        expect([fixture.statePath, agentPath]).not.toContain(copiedPath);
        copiedPaths.push(copiedPath);
        for (const suffix of ["-wal", "-shm", "-journal"]) {
          await expect(fs.access(`${copiedPath}${suffix}`)).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        using snapshot = new DatabaseSync(copiedPath, { readOnly: true });
        if (kind === "state") {
          expect(
            snapshot.prepare("SELECT rowid, agent_id, path FROM agent_databases").all(),
          ).toEqual([
            { rowid: 1, agent_id: "removed", path: "removed-agent.sqlite" },
            { rowid: 2, agent_id: "active", path: agentPath },
          ]);
        }
        expect(snapshot.prepare("PRAGMA journal_mode").get()).toEqual({
          journal_mode: "delete",
        });
        expect(snapshot.prepare("SELECT rowid, value FROM wal_probe").all()).toEqual([
          { rowid: 2, value: "committed-wal" },
        ]);
        return preflightResult(kind);
      });

      await assertNodeRuntimeUpdateCompatible(fixture);

      expect(mocks.command).toHaveBeenCalledTimes(2);
      expect(snapshotPreflightSourceManifest(fixture.stateDir)).toEqual(before);
      expect(await fs.readdir(path.dirname(fixture.statePath))).toEqual(stateEntries);
      for (const copiedPath of copiedPaths) {
        await expect(fs.access(copiedPath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });

    it.each([
      { status: "incompatible", code: 1, reason: "unexpected column" },
      { status: "startup-repairable", code: 0, reason: "required startup repair" },
    ])(
      "defers $status without changing source state or retaining its private copy",
      async ({ status, code, reason }) => {
        const before = await fs.readFile(fixture.statePath);
        let copiedPath = "";
        mocks.command.mockImplementation(async (argv: string[]) => {
          copiedPath = argv[argv.indexOf("database") + 2] ?? "";
          return preflightResult("state", status, code, reason);
        });
        await expect(assertNodeRuntimeUpdateCompatible(fixture)).rejects.toThrow(reason);
        expect(await fs.readFile(fixture.statePath)).toEqual(before);
        await expect(fs.access(copiedPath)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });
});

describe("Bun private node runtime installation", () => {
  useNodeUpdateRuntime("bun", "linux");
  const archive = Buffer.from("synthetic registry archive");
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const registryUrl = "http://127.0.0.1:4873/";
  const tarballUrl = `${registryUrl}openclaw/-/openclaw-${VERSION}.tgz`;
  const fetchMock = vi.fn<typeof fetch>();

  function serveManifest(dist = { integrity, tarball: tarballUrl }) {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        name: "openclaw",
        version: VERSION,
        openclaw: metadata.packageOpenClaw,
        dist,
      }),
    );
    fetchMock.mockResolvedValueOnce(new Response(archive));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_UPDATE_PACKAGE_SPEC", "openclaw");
    vi.stubEnv("NPM_CONFIG_REGISTRY", registryUrl);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("prepares and retains a Bun generation without npm or user-global bins", async () => {
    const stateDir = tempDirs.make("openclaw-node-bun-");
    serveManifest();
    mocks.command.mockImplementation(
      async (argv: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => {
        if (options.cwd) {
          // A real spawn fails with ENOENT when its working directory is missing.
          await fs.access(options.cwd);
        }
        const { BUN_INSTALL_GLOBAL_DIR: project, BUN_INSTALL_BIN: bin } = options.env;
        if (argv.join(" ") === [process.execPath, "pm", "bin", "-g"].join(" ")) {
          // Bun requires its global project manifest before any global command.
          await fs.access(path.join(project!, "package.json"));
          return { code: 0, stdout: `${bin}\n`, stderr: "" };
        }
        if (argv[0] === process.execPath && argv[1] === "add" && project && bin) {
          const archiveSpec = argv.find((arg) => arg.startsWith("openclaw@file:"));
          expect(archiveSpec).toBeDefined();
          expect(await fs.readFile(archiveSpec!.slice("openclaw@file:".length))).toEqual(archive);
          const root = path.join(project, "node_modules", "openclaw");
          await writeCandidate(root);
          await fs.symlink(path.join(root, "openclaw.mjs"), path.join(bin, "openclaw"));
          return { code: 0, stdout: "installed", stderr: "" };
        }
        throw new Error(`Unexpected external command: ${argv.join(" ")}`);
      },
    );

    const candidate = await prepare(stateDir);
    expect(candidate).toMatchObject({ version: VERSION, integrity });
    expect(candidate.packageRoot).toBe(
      path.join(candidate.runtimeRoot, "lib", "node_modules", "openclaw"),
    );
    expectNoNpm();
    expect(mocks.command.mock.calls.some(([argv]) => argv[0].startsWith("npm"))).toBe(false);
    const install = mocks.command.mock.calls.find(([argv]) => argv[1] === "add");
    expect(install?.[0]).toEqual([
      process.execPath,
      "add",
      "-g",
      "--trust",
      expect.stringMatching(/^openclaw@file:.*\.tgz$/u),
    ]);
    for (const [, options] of mocks.command.mock.calls) {
      expect(
        options.env.BUN_INSTALL_GLOBAL_DIR.startsWith(`${candidate.runtimeRoot}${path.sep}`),
      ).toBe(true);
      expect(options.env.BUN_INSTALL_BIN.startsWith(`${candidate.runtimeRoot}${path.sep}`)).toBe(
        true,
      );
      expect(options.env.OPENCLAW_PACKAGE_BUN_LAUNCHER).toBe(process.execPath);
      // Npm freshness policy would probe `npm config get globalconfig`.
      expect(options.env.npm_config_before).toBeUndefined();
      expect(options.env.npm_config_min_release_age).toBeUndefined();
    }
    expect(await fs.realpath(path.join(candidate.runtimeRoot, "bin", "openclaw"))).toBe(
      path.join(candidate.packageRoot, "openclaw.mjs"),
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${registryUrl}openclaw/${VERSION}`,
      tarballUrl,
    ]);
    mocks.command.mockClear();
    serveManifest();
    expect(await prepare(stateDir)).toEqual(candidate);
    expect(mocks.command).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    { integrity: metadata.integrity!, tarball: tarballUrl, error: "integrity mismatch" },
    { integrity, tarball: "https://other.example/openclaw.tgz", error: "registry origin" },
    { integrity: "sha256-unsupported", tarball: tarballUrl, error: "sha512 integrity" },
    { integrity: "", tarball: tarballUrl, error: "requested release and integrity" },
  ])("rejects $error before installing", async ({ error, ...dist }) => {
    const stateDir = tempDirs.make("openclaw-node-bun-invalid-");
    serveManifest(dist);
    await expect(prepare(stateDir)).rejects.toThrow(error);
    expect(mocks.command).not.toHaveBeenCalled();
    expectNoNpm();
    expect(await fs.readdir(stateDir)).toEqual([]);
  });

  it("keeps npm metadata and packing on Windows under Bun", async () => {
    const stateDir = tempDirs.make("openclaw-node-bun-windows-");
    // Simulating Windows must not change the host filesystem's temp-path semantics.
    vi.spyOn(tmpOpenClawDir, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      tempDirs.make("openclaw-node-bun-windows-tmp-"),
    );
    Object.defineProperty(process, "platform", { value: "win32" });
    mocks.pack.mockResolvedValue({ ok: false, error: "synthetic npm pack failure" });
    await expect(prepare(stateDir)).rejects.toThrow("synthetic npm pack failure");
    expect(mocks.resolve).toHaveBeenCalledWith({ spec: `openclaw@${VERSION}`, signal: undefined });
    expect(mocks.pack).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("private node runtime installation", () => {
  useNodeUpdateRuntime("node");

  it("installs a verified generation without changing the global runtime or live state", async () => {
    const directory = tempDirs.make("openclaw-node-install-");
    const globalPrefix = path.join(directory, "global");
    const globalRoot = path.join(
      resolveNpmGlobalPrefixLayoutFromPrefix(globalPrefix).globalRoot,
      "openclaw",
    );
    await writeCandidate(globalRoot, "2026.9.17");
    vi.stubEnv("npm_config_prefix", globalPrefix);
    const stateDir = path.join(directory, "state");
    const candidate = await prepare(stateDir);

    expect(candidate.runtimeRoot.startsWith(path.join(stateDir, "node-runtime", "releases"))).toBe(
      true,
    );
    expect(candidate).toMatchObject({ version: VERSION, integrity: metadata.integrity });
    expect(await readPackage(candidate.packageRoot)).toMatchObject({ version: VERSION });
    expect(await readPackage(globalRoot)).toMatchObject({ version: "2026.9.17" });
    await expect(fs.access(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const install = mocks.command.mock.calls.find(([argv]) => argv.includes("i"));
    expect(install?.[1].env.OPENCLAW_STATE_DIR).not.toBe(stateDir);
    expect(install?.[1].env.OPENCLAW_CONFIG_PATH).toContain("openclaw-node-update-");

    mocks.pack.mockClear();
    mocks.command.mockClear();
    expect(await prepare(stateDir)).toEqual(candidate);
    expect(mocks.pack).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();

    await fs.unlink(path.join(candidate.packageRoot, "node-host-launcher.mjs"));
    const recovered = await prepare(stateDir);
    expect(recovered.runtimeRoot).not.toBe(candidate.runtimeRoot);
    expect(recovered.warnings?.[0]).toContain(candidate.runtimeRoot);
    expect(await fs.readFile(path.join(candidate.packageRoot, "package.json"), "utf8")).toBe(
      await fs.readFile(path.join(recovered.packageRoot, "package.json"), "utf8"),
    );
    await expect(
      fs.access(path.join(candidate.packageRoot, "node-host-launcher.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await fs.access(path.join(recovered.packageRoot, "node-host-launcher.mjs"));
  });

  it.each(["integrity", "state", "agent"] as const)(
    "rejects changed %s before installing anything",
    async (changed) => {
      const stateDir = tempDirs.make("openclaw-node-rejected-");
      if (changed === "integrity") {
        mocks.pack.mockResolvedValue({
          ok: true,
          archivePath: path.join(stateDir, "candidate.tgz"),
          metadata: {
            ...metadata,
            integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
          },
        });
      } else {
        mocks.resolve.mockResolvedValue({
          ok: true,
          metadata: {
            ...metadata,
            packageOpenClaw: {
              schemaVersions: {
                ...nodeUpdateMetadata.packageOpenClaw.schemaVersions,
                [changed]: 999,
              },
            },
          },
        });
      }
      await expect(prepare(stateDir)).rejects.toThrow(
        changed === "integrity" ? "integrity drift" : "openclaw update",
      );
      if (changed !== "integrity") {
        expect(mocks.pack).not.toHaveBeenCalled();
      }
      expect(mocks.command).not.toHaveBeenCalled();
      expect(await fs.readdir(stateDir)).toEqual([]);
    },
  );

  it("leaves the current selection and old runtime intact when npm fails", async () => {
    const stateDir = tempDirs.make("openclaw-node-install-failure-");
    const runtimeDir = path.join(stateDir, "node-runtime");
    const oldRoot = path.join(runtimeDir, "releases", "old");
    await fs.mkdir(oldRoot, { recursive: true });
    await fs.writeFile(path.join(oldRoot, "running"), "old runtime");
    await fs.symlink(
      oldRoot,
      path.join(runtimeDir, "current"),
      process.platform === "win32" ? "junction" : undefined,
    );
    mocks.command.mockImplementation(async (argv: string[]) =>
      argv.at(-1) === "--version"
        ? { code: 0, stdout: "12.0.0", stderr: "" }
        : { code: 1, stdout: "", stderr: "registry offline" },
    );

    await expect(prepare(stateDir)).rejects.toThrow("registry offline");
    expect(await fs.realpath(path.join(runtimeDir, "current"))).toBe(oldRoot);
    expect(await fs.readFile(path.join(oldRoot, "running"), "utf8")).toBe("old runtime");
  });
});
