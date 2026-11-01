import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
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
    const result = expect(doctorDatabasePort(options));
    if (expected instanceof RegExp) {
      await result.rejects.toThrow(expected);
    } else {
      await result.resolves.toMatchObject(expected);
    }
    expect(await fs.readFile(state.configPath)).toEqual(before);
    if (store) {
      expect(await fs.readFile(store, "utf8")).toBe(retained);
      expect(await fs.readdir(state.statePath("state"))).toEqual(["openclaw.sqlite"]);
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
