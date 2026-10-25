import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { doctorDatabasePort, type DatabasePortOptions } from "./doctor-database-port.js";

describe("native Windows database port", () => {
  it.each([
    { to: "postgres" },
    { to: "sqlite" },
    { to: "postgres", dryRun: true },
    { resume: "missing-manifest.json" },
    { rollback: "missing-manifest.json" },
  ] satisfies DatabasePortOptions[])(
    "refuses with supported alternatives before touching files (%j)",
    async (options) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({ database: { engine: "sqlite" } });
        const database = await state.writeText("state/openclaw.sqlite", "retained state bytes");
        const configBefore = await fs.readFile(state.configPath);
        const filesBefore = (await listDirectoryTreeStrict(state.stateDir)).map(
          (entry) => entry.relativePath,
        );
        const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        try {
          await expect(doctorDatabasePort(options)).rejects.toThrow(
            /Native Windows does not support SQLite.*PostgreSQL database port yet.*Existing data and engine selection stay unchanged.*fresh PostgreSQL setup on Windows.*Linux or macOS/s,
          );
        } finally {
          platform.mockRestore();
        }
        expect(await fs.readFile(database, "utf8")).toBe("retained state bytes");
        expect(await fs.readFile(state.configPath)).toEqual(configBefore);
        expect(
          (await listDirectoryTreeStrict(state.stateDir)).map((entry) => entry.relativePath),
        ).toEqual(filesBefore);
      });
    },
  );
});

describe.skipIf(process.platform === "win32")("database port engine-selection admission", () => {
  it.each([{ to: "postgres" }, { to: "sqlite", dryRun: true }] satisfies DatabasePortOptions[])(
    "requires a family for mixed installs before touching stores (%j)",
    async (options) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          database: {
            engine: "sqlite",
            families: { workboard: { engine: "postgres" } },
            postgres: { connection: "postgres://synthetic.invalid/unused" },
          },
        });
        const database = await state.writeText("state/openclaw.sqlite", "retained state bytes");
        const before = await fs.readFile(state.configPath);
        await expect(doctorDatabasePort(options)).rejects.toThrow(
          /Mixed-engine database port requires --family/,
        );
        expect(await fs.readFile(database, "utf8")).toBe("retained state bytes");
        expect(await fs.readFile(state.configPath)).toEqual(before);
        expect(await fs.readdir(state.statePath("state"))).toEqual(["openclaw.sqlite"]);
      });
    },
  );

  it.each(["sqlite", "postgres"] as const)(
    "keeps homogeneous %s no-op ports unchanged",
    async (engine) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          database: { engine, postgres: { connection: "postgres://synthetic.invalid/unused" } },
          plugins: { enabled: false },
        });
        const before = await fs.readFile(state.configPath);
        await expect(doctorDatabasePort({ to: engine, dryRun: true })).resolves.toMatchObject({
          phase: "preflight",
          engine,
          stores: [],
        });
        expect(await fs.readFile(state.configPath)).toEqual(before);
      });
    },
  );

  it.each([
    {
      database: { engine: "sqlite", families: { workboard: { engine: "sqlite" } } },
      to: "postgres",
    },
    {
      database: {
        engine: "sqlite",
        families: {
          state: { engine: "postgres" },
          workboard: { engine: "postgres" },
          logbook: { engine: "postgres" },
          "team-reports": { engine: "postgres" },
        },
      },
      to: "sqlite",
    },
  ] satisfies {
    database: NonNullable<OpenClawConfig["database"]>;
    to: DatabasePortOptions["to"];
  }[])(
    "refuses a global port that cannot move the pinned family selection (%j)",
    async ({ database, to }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          database: {
            ...database,
            postgres: { connection: "postgres://synthetic.invalid/unused" },
          },
          plugins: { enabled: false },
        });
        const before = await fs.readFile(state.configPath);
        await expect(doctorDatabasePort({ to, dryRun: true })).rejects.toThrow(
          /requires --family|require --family/,
        );
        expect(await fs.readFile(state.configPath)).toEqual(before);
      });
    },
  );
});
