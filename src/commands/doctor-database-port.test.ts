import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { DatabasePortError } from "../infra/database-engine/port-command.worker.js";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { doctorDatabasePort, type DatabasePortOptions } from "./doctor-database-port.js";

async function checkSelection(
  config: OpenClawConfig,
  options: DatabasePortOptions,
  expected: RegExp | { phase: string; engine: string; stores: never[] },
  preserveStore = false,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeConfig(config);
    const before = await fs.readFile(state.configPath);
    const store = preserveStore && (await state.writeText("state/openclaw.sqlite", retained));
    const filesBefore = store && (await tree(state.stateDir));
    const result = expect(doctorDatabasePort(options));
    if (expected instanceof RegExp) {
      await result.rejects.toThrow(expected);
    } else {
      await result.resolves.toMatchObject(expected);
    }
    expect(await fs.readFile(state.configPath)).toEqual(before);
    if (store) {
      expect(await fs.readFile(store, "utf8")).toBe(retained);
      expect(await tree(state.stateDir)).toEqual(filesBefore);
    }
  });
}

const postgres = { connection: "postgres://synthetic.invalid/unused" };
const retained = "retained state bytes";
const tree = async (root: string) =>
  (await listDirectoryTreeStrict(root)).map((entry) => entry.relativePath);

describe("native Windows database port", () => {
  it.each([
    { to: "postgres" },
    { resume: "missing-manifest.json" },
    { rollback: "missing-manifest.json" },
  ] satisfies DatabasePortOptions[])(
    "refuses with supported alternatives before touching files (%j)",
    async (options) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({ database: { engine: "sqlite" } });
        const database = await state.writeText("state/openclaw.sqlite", retained);
        const configBefore = await fs.readFile(state.configPath);
        const filesBefore = await tree(state.stateDir);
        const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        try {
          await expect(doctorDatabasePort(options)).rejects.toThrow(
            /Native Windows does not support SQLite.*PostgreSQL database port yet.*Existing data and engine selection stay unchanged.*fresh PostgreSQL setup on Windows.*Linux or macOS/s,
          );
        } finally {
          platform.mockRestore();
        }
        expect(await fs.readFile(database, "utf8")).toBe(retained);
        expect(await fs.readFile(state.configPath)).toEqual(configBefore);
        expect(await tree(state.stateDir)).toEqual(filesBefore);
      });
    },
  );
});

describe.skipIf(process.platform === "win32")("database port engine-selection admission", () => {
  it.each([
    { to: "sqlite" },
    { to: "sqlite", family: "state", dryRun: true },
  ] satisfies DatabasePortOptions[])(
    "refuses a SQLite destination with installation ownership before touching stores (%j)",
    (options) =>
      checkSelection(
        { database: { engine: "postgres", postgres: { ...postgres, ownership: "installation" } } },
        options,
        /database\.postgres\.ownership.*installation.*state-directory/,
        true,
      ),
  );

  it("requires a family for mixed installs before touching stores", async () => {
    await checkSelection(
      {
        database: { engine: "sqlite", families: { workboard: { engine: "postgres" } }, postgres },
      },
      { to: "postgres" },
      /Mixed-engine database port requires --family/,
      true,
    );
  });

  it.each(["sqlite", "postgres"] as const)(
    "keeps homogeneous %s no-op ports unchanged",
    async (engine) => {
      await checkSelection(
        { database: { engine, postgres }, plugins: { enabled: false } },
        { to: engine, dryRun: true },
        { phase: "preflight", engine, stores: [] },
      );
    },
  );

  it("refuses a global port that cannot move the pinned family selection", async () => {
    await checkSelection(
      {
        database: { engine: "sqlite", families: { workboard: { engine: "sqlite" } }, postgres },
        plugins: { enabled: false },
      },
      { to: "postgres", dryRun: true },
      /requires --family|require --family/,
    );
  });
});

describe.skipIf(process.platform === "win32")("database port Doctor contract preflight", () => {
  it.each([
    { status: "healthy", source: "module.exports = {};", declared: false },
    {
      status: "unavailable",
      source: 'throw new Error("fixture contract load failed");',
      declared: false,
    },
    {
      status: "unavailable",
      source: 'throw new Error("fixture contract load failed");',
      declared: true,
    },
    { status: "mismatched", source: "module.exports = {};", declared: true },
  ])(
    "handles a $status Doctor contract (declared=$declared)",
    async ({ status, source, declared }) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
        async (state) => {
          const plugin = "port-fixture";
          const root = `extensions/${plugin}`;
          await state.writeJson(`${root}/openclaw.plugin.json`, {
            id: plugin,
            configSchema: { type: "object" },
            ...(declared
              ? { doctorContract: { stateMigrations: [{ id: "fixture-migration" }] } }
              : {}),
          });
          await state.writeText(`${root}/index.cjs`, "module.exports = {};");
          await state.writeText(`${root}/doctor-contract-api.cjs`, source);
          await state.writeConfig({ database: { engine: "sqlite", postgres } });

          const runPort = async (options: DatabasePortOptions) => {
            const cache = createPluginCache();
            try {
              return await withPluginCache(cache, () => doctorDatabasePort(options));
            } finally {
              // Captured plugin code must retire before the fixture removes its state directory.
              const { failures } = await retirePluginCache(cache, undefined, {
                waitForSettlement: true,
              });
              expect(failures).toEqual([]);
            }
          };
          if (status === "healthy") {
            await expect(
              runPort({ family: "state", to: "postgres", dryRun: true }),
            ).resolves.toMatchObject({ phase: "preflight", stores: [] });
            return;
          }

          const configBefore = await fs.readFile(state.configPath);
          const port = runPort({ family: "state", to: "postgres", dryRun: true });
          await expect(port).rejects.toBeInstanceOf(DatabasePortError);
          await expect(port).rejects.toThrow(
            status === "mismatched"
              ? /immutable action order and authority declared by port-fixture.*doctor --fix.*retry/s
              : /plugin "port-fixture": .*fixture contract load failed.*Fix or remove each named plugin.*retry/s,
          );
          expect(await fs.readFile(state.configPath)).toEqual(configBefore);
          await expect(fs.stat(state.statePath("recovery", "database-port"))).rejects.toMatchObject(
            {
              code: "ENOENT",
            },
          );
        },
      );
    },
  );
});
