import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimePaths from "../daemon/runtime-paths.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { prepareGitCandidateNodeRuntime } from "../infra/update-runner-git-node-preflight.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { snapshotPreflightSourceManifest } from "../state/openclaw-database-preflight.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { assertNodeRuntimeUpdateCompatible } from "./auto-update-compatibility.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  nodeRuntime: vi.fn<typeof prepareGitCandidateNodeRuntime>(async () => ({ env: {} })),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.nodeRuntime.mockResolvedValue({ env: {} });
});

async function createCompatibilityFixture(directory: string) {
  const stateDir = path.join(directory, "node-state");
  const packageRoot = path.join(directory, "candidate");
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.18",
        openclaw: {
          schemaVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        },
      }),
    ),
    ...[
      "openclaw.mjs",
      "node-host-launcher.mjs",
      "dist/node-host-launcher-bootstrap.js",
      "dist/entry.js",
    ].map((relativePath) => fs.writeFile(path.join(packageRoot, relativePath), "export {};\n")),
  ]);
  const statePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(statePath);
  try {
    database.exec("CREATE TABLE agent_databases (agent_id TEXT, path TEXT);");
    database
      .prepare("INSERT INTO agent_databases VALUES (?, ?)")
      .run("removed", "removed-agent.sqlite");
  } finally {
    database.close();
  }
  return { stateDir, packageRoot, statePath };
}

describe("candidate node runtime compatibility", () => {
  const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");

  afterEach(() => {
    if (bunVersion) {
      Object.defineProperty(process.versions, "bun", bunVersion);
    } else {
      Reflect.deleteProperty(process.versions, "bun");
    }
  });

  it("keeps a supported renamed Node host independent of package-tooling discovery", async () => {
    const originalExecPath = process.execPath;
    const originalVersions = process.versions;
    const { prepareGitCandidateNodeRuntime: prepareRuntime } = await vi.importActual<
      typeof import("../infra/update-runner-git-node-preflight.js")
    >("../infra/update-runner-git-node-preflight.js");
    const system = vi.spyOn(runtimePaths, "resolveSystemNodeInfo").mockResolvedValue(null);
    mocks.nodeRuntime.mockImplementation(prepareRuntime);
    Object.defineProperty(process, "versions", {
      value: { ...originalVersions, node: "26.7.0", bun: undefined },
    });
    vi.stubEnv("PATH", "");
    Object.defineProperty(process, "execPath", { value: path.resolve("fixture", "node26") });
    try {
      await withTestDir({ prefix: "openclaw-node-compat-runtime-" }, async (directory) => {
        const fixture = await createCompatibilityFixture(directory);
        await fs.rm(fixture.statePath);
        await expect(assertNodeRuntimeUpdateCompatible(fixture)).resolves.toBeUndefined();
        expect(system).not.toHaveBeenCalled();
      });
    } finally {
      Object.defineProperty(process, "execPath", { value: originalExecPath });
      Object.defineProperty(process, "versions", { value: originalVersions });
      vi.unstubAllEnvs();
      system.mockRestore();
    }
  });

  it.each([
    { runtime: "node", accepted: false },
    { runtime: "bun", accepted: true },
  ])("applies Node engines only on a Node host ($runtime)", async ({ runtime, accepted }) => {
    if (runtime === "bun") {
      Object.defineProperty(process.versions, "bun", { value: "1.4.3", configurable: true });
    } else {
      Reflect.deleteProperty(process.versions, "bun");
    }
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
    mocks.command.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({ schema: "openclaw.state-schema-preflight.v1", status: "exact" }),
      stderr: "",
    });
    await withTestDir({ prefix: "openclaw-node-compat-runtime-" }, async (directory) => {
      const compatible = assertNodeRuntimeUpdateCompatible(
        await createCompatibilityFixture(directory),
      );
      await (accepted
        ? expect(compatible).resolves.toBeUndefined()
        : expect(compatible).rejects.toThrow("No system Node was found."));
    });
  });
});

describe("candidate node database compatibility", () => {
  it("accepts an exact match from the candidate using a disposable copy", async () => {
    await withTestDir({ prefix: "openclaw-node-compat-" }, async (directory) => {
      const fixture = await createCompatibilityFixture(directory);
      const before = await fs.readFile(fixture.statePath);
      let copiedPath = "";
      mocks.command.mockImplementation(async (argv: string[]) => {
        expect(argv[1]).toBe(path.join(fixture.packageRoot, "openclaw.mjs"));
        expect(argv.slice(2, 4)).toEqual(["database", "preflight"]);
        copiedPath = argv[4] ?? "";
        expect(copiedPath).not.toBe(fixture.statePath);
        const snapshot = new (requireNodeSqlite().DatabaseSync)(copiedPath, { readOnly: true });
        try {
          expect(
            snapshot.prepare("SELECT rowid, agent_id, path FROM agent_databases").all(),
          ).toEqual([{ rowid: 1, agent_id: "removed", path: "removed-agent.sqlite" }]);
        } finally {
          snapshot.close();
        }
        return {
          code: 0,
          stdout: JSON.stringify({ schema: "openclaw.state-schema-preflight.v1", status: "exact" }),
          stderr: "",
        };
      });
      await assertNodeRuntimeUpdateCompatible(fixture);
      expect(mocks.command).toHaveBeenCalledTimes(1);
      expect(await fs.readFile(fixture.statePath)).toEqual(before);
      expect(await fs.readdir(path.dirname(fixture.statePath))).toEqual(["openclaw.sqlite"]);
      await expect(fs.access(copiedPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("consolidates committed state and agent WAL rows without changing their live families", async () => {
    await withTestDir({ prefix: "openclaw-node-wal-compat-" }, async (directory) => {
      const fixture = await createCompatibilityFixture(directory);
      const { DatabaseSync } = requireNodeSqlite();
      const state = new DatabaseSync(fixture.statePath);
      const agentPath = path.join(fixture.stateDir, "agent.sqlite");
      const agent = new DatabaseSync(agentPath);
      try {
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
        const copiedPaths: string[] = [];
        mocks.command.mockImplementation(async (argv: string[]) => {
          const copiedPath = argv[4] ?? "";
          copiedPaths.push(copiedPath);
          for (const suffix of ["-wal", "-shm", "-journal"]) {
            await expect(fs.access(`${copiedPath}${suffix}`)).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
          const snapshot = new DatabaseSync(copiedPath, { readOnly: true });
          try {
            expect(snapshot.prepare("PRAGMA journal_mode").get()).toEqual({
              journal_mode: "delete",
            });
            expect(snapshot.prepare("SELECT rowid, value FROM wal_probe").all()).toEqual([
              { rowid: 2, value: "committed-wal" },
            ]);
          } finally {
            snapshot.close();
          }
          return {
            code: 0,
            stdout: JSON.stringify({
              schema:
                argv[3] === "preflight"
                  ? "openclaw.state-schema-preflight.v1"
                  : "openclaw.agent-schema-preflight.v1",
              status: "exact",
            }),
            stderr: "",
          };
        });

        await assertNodeRuntimeUpdateCompatible(fixture);

        expect(mocks.command).toHaveBeenCalledTimes(2);
        expect(snapshotPreflightSourceManifest(fixture.stateDir)).toEqual(before);
        for (const copiedPath of copiedPaths) {
          await expect(fs.access(copiedPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        agent.close();
        state.close();
      }
    });
  });

  it.each([
    { status: "incompatible", code: 1, reason: "unexpected column" },
    { status: "startup-repairable", code: 0, reason: "required startup repair" },
  ])(
    "defers $status without changing source state or retaining its private copy",
    async ({ status, code, reason }) => {
      await withTestDir({ prefix: "openclaw-node-incompatible-" }, async (directory) => {
        const fixture = await createCompatibilityFixture(directory);
        const before = await fs.readFile(fixture.statePath);
        let copiedPath = "";
        mocks.command.mockImplementation(async (argv: string[]) => {
          copiedPath = argv[4] ?? "";
          return {
            code,
            stdout: JSON.stringify({
              schema: "openclaw.state-schema-preflight.v1",
              status,
              reason,
            }),
            stderr: "",
          };
        });
        await expect(assertNodeRuntimeUpdateCompatible(fixture)).rejects.toThrow(reason);
        expect(await fs.readFile(fixture.statePath)).toEqual(before);
        await expect(fs.access(copiedPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});
