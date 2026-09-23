import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.js";
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
