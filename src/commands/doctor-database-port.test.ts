import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { doctorDatabasePort, type DatabasePortOptions } from "./doctor-database-port.js";

describe("database port engine-selection admission", () => {
  it.each([
    { to: "postgres" },
    { to: "sqlite", dryRun: true },
    { resume: "unread-recovery.json" },
    { rollback: "unread-recovery.json" },
  ] satisfies DatabasePortOptions[])(
    "refuses mixed installs before touching stores (%j)",
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
          /port for mixed-engine installs is not supported yet; use a single engine/,
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
          /port .*not supported yet; use a single engine/,
        );
        expect(await fs.readFile(state.configPath)).toEqual(before);
      });
    },
  );
});
