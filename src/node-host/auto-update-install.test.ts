import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { UpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "../infra/update-npm-prefix.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { prepareNodeRuntimeUpdate } from "./auto-update-install.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  pack: vi.fn(),
  command: vi.fn(),
  assertCurrent: vi.fn(),
}));

vi.mock("../cli/update-cli/update-command-executor.js", () => ({
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
  checkGitCandidateNodeRuntime: async () => null,
}));
vi.mock("../state/openclaw-database-preflight.js", () => ({
  preflightOpenClawDatabaseSchemas: async () => ({ incompatible: [], indeterminate: [] }),
}));

const VERSION = "2026.9.18";
const metadata: NpmSpecResolution = {
  name: "openclaw",
  version: VERSION,
  integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
  packageOpenClaw: {
    schemaVersions: { state: OPENCLAW_STATE_SCHEMA_VERSION, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
  },
};

async function writeCandidate(packageRoot: string, version = VERSION): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version, openclaw: metadata.packageOpenClaw }),
    ),
    ...[
      "openclaw.mjs",
      "node-host-launcher.mjs",
      "dist/node-host-launcher-bootstrap.js",
      "dist/entry.js",
    ].map((relativePath) => fs.writeFile(path.join(packageRoot, relativePath), "export {};\n")),
  ]);
  await writePackageDistInventory(packageRoot);
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe("Bun private node runtime installation", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
  const platform = process.platform;
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
    Object.defineProperty(process.versions, "bun", { value: "1.4.3", configurable: true });
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.stubEnv("OPENCLAW_UPDATE_PACKAGE_SPEC", "openclaw");
    vi.stubEnv("NPM_CONFIG_REGISTRY", registryUrl);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    if (bunVersion) {
      Object.defineProperty(process.versions, "bun", bunVersion);
    } else {
      Reflect.deleteProperty(process.versions, "bun");
    }
    Object.defineProperty(process, "platform", { value: platform });
    vi.unstubAllGlobals();
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
        if (argv.join(" ") === "bun pm bin -g") {
          // Bun requires its global project manifest before any global command.
          await fs.access(path.join(project!, "package.json"));
          return { code: 0, stdout: `${bin}\n`, stderr: "" };
        }
        if (argv[0] === "bun" && argv[1] === "add" && project && bin) {
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

    const candidate = await prepareNodeRuntimeUpdate({ targetVersion: VERSION, stateDir });
    expect(candidate).toMatchObject({ version: VERSION, integrity });
    expect(candidate.packageRoot).toBe(
      path.join(candidate.runtimeRoot, "lib", "node_modules", "openclaw"),
    );
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.pack).not.toHaveBeenCalled();
    expect(mocks.command.mock.calls.some(([argv]) => argv[0].startsWith("npm"))).toBe(false);
    const install = mocks.command.mock.calls.find(([argv]) => argv[1] === "add");
    expect(install?.[0]).toEqual([
      "bun",
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
    expect(await prepareNodeRuntimeUpdate({ targetVersion: VERSION, stateDir })).toEqual(candidate);
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
    await expect(prepareNodeRuntimeUpdate({ targetVersion: VERSION, stateDir })).rejects.toThrow(
      error,
    );
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.pack).not.toHaveBeenCalled();
    expect(await fs.readdir(stateDir)).toEqual([]);
  });

  it("keeps npm metadata and packing on Windows under Bun", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const stateDir = tempDirs.make("openclaw-node-bun-windows-");
    mocks.pack.mockResolvedValue({ ok: false, error: "synthetic npm pack failure" });
    await expect(prepareNodeRuntimeUpdate({ targetVersion: VERSION, stateDir })).rejects.toThrow(
      "synthetic npm pack failure",
    );
    expect(mocks.resolve).toHaveBeenCalledWith({ spec: `openclaw@${VERSION}`, signal: undefined });
    expect(mocks.pack).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("private node runtime installation", () => {
  it("installs a verified generation without changing the global runtime or live state", async () => {
    await withTestDir({ prefix: "openclaw-node-install-" }, async (directory) => {
      const globalPrefix = path.join(directory, "global");
      const globalRoot = path.join(
        resolveNpmGlobalPrefixLayoutFromPrefix(globalPrefix).globalRoot,
        "openclaw",
      );
      await writeCandidate(globalRoot, "2026.9.17");
      vi.stubEnv("npm_config_prefix", globalPrefix);
      const stateDir = path.join(directory, "state");
      const candidate = await prepareNodeRuntimeUpdate({ targetVersion: VERSION, stateDir });

      expect(
        candidate.runtimeRoot.startsWith(path.join(stateDir, "node-runtime", "releases")),
      ).toBe(true);
      expect(candidate).toMatchObject({ version: VERSION, integrity: metadata.integrity });
      expect(
        JSON.parse(await fs.readFile(path.join(candidate.packageRoot, "package.json"), "utf8")),
      ).toMatchObject({ version: VERSION });
      expect(
        JSON.parse(await fs.readFile(path.join(globalRoot, "package.json"), "utf8")),
      ).toMatchObject({ version: "2026.9.17" });
      await expect(
        fs.access(path.join(stateDir, "state", "openclaw.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const install = mocks.command.mock.calls.find(([argv]) => argv.includes("i"));
      expect(install?.[1].env.OPENCLAW_STATE_DIR).not.toBe(stateDir);
      expect(install?.[1].env.OPENCLAW_CONFIG_PATH).toContain("openclaw-node-update-");

      mocks.pack.mockClear();
      mocks.command.mockClear();
      expect(await prepareNodeRuntimeUpdate({ targetVersion: VERSION, stateDir })).toEqual(
        candidate,
      );
      expect(mocks.pack).not.toHaveBeenCalled();
      expect(mocks.command).not.toHaveBeenCalled();

      await fs.unlink(path.join(candidate.packageRoot, "node-host-launcher.mjs"));
      const recovered = await prepareNodeRuntimeUpdate({ targetVersion: VERSION, stateDir });
      expect(recovered.runtimeRoot).not.toBe(candidate.runtimeRoot);
      expect(recovered.warnings?.[0]).toContain(candidate.runtimeRoot);
      expect(await fs.readFile(path.join(candidate.packageRoot, "package.json"), "utf8")).toBe(
        await fs.readFile(path.join(recovered.packageRoot, "package.json"), "utf8"),
      );
      await expect(
        fs.access(path.join(candidate.packageRoot, "node-host-launcher.mjs")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.access(path.join(recovered.packageRoot, "node-host-launcher.mjs")),
      ).resolves.toBeUndefined();
    });
  });

  it("rejects archive integrity drift before installing anything", async () => {
    await withTestDir({ prefix: "openclaw-node-integrity-" }, async (stateDir) => {
      mocks.pack.mockResolvedValue({
        ok: true,
        archivePath: path.join(stateDir, "candidate.tgz"),
        metadata: { ...metadata, integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}` },
      });
      await expect(prepareNodeRuntimeUpdate({ targetVersion: VERSION, stateDir })).rejects.toThrow(
        "integrity drift",
      );
      expect(mocks.command).not.toHaveBeenCalled();
      expect(await fs.readdir(stateDir)).toEqual([]);
    });
  });

  it.each(["state", "agent"] as const)(
    "defers a changed %s schema before downloading a release",
    async (schema) => {
      await withTestDir({ prefix: "openclaw-node-schema-" }, async (stateDir) => {
        mocks.resolve.mockResolvedValue({
          ok: true,
          metadata: {
            ...metadata,
            packageOpenClaw: {
              schemaVersions: {
                state: OPENCLAW_STATE_SCHEMA_VERSION,
                agent: OPENCLAW_AGENT_SCHEMA_VERSION,
                [schema]: 999,
              },
            },
          },
        });
        await expect(
          prepareNodeRuntimeUpdate({ targetVersion: VERSION, stateDir }),
        ).rejects.toThrow("openclaw update");
        expect(mocks.pack).not.toHaveBeenCalled();
        expect(await fs.readdir(stateDir)).toEqual([]);
      });
    },
  );

  it("leaves the current selection and old runtime intact when npm fails", async () => {
    await withTestDir({ prefix: "openclaw-node-install-failure-" }, async (stateDir) => {
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

      await expect(prepareNodeRuntimeUpdate({ targetVersion: VERSION, stateDir })).rejects.toThrow(
        "registry offline",
      );
      expect(await fs.realpath(path.join(runtimeDir, "current"))).toBe(oldRoot);
      expect(await fs.readFile(path.join(oldRoot, "running"), "utf8")).toBe("old runtime");
    });
  });
});
