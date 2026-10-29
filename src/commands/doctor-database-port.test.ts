import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { assertDatabasePortPlatformSupported } from "../infra/database-port-recovery.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { doctorDatabasePort, type DatabasePortOptions } from "./doctor-database-port.js";

describe("native Windows database port", () => {
  it.each(["linux", "darwin"] as const)("does not reject the supported %s platform", (platform) => {
    const spy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    try {
      expect(() => assertDatabasePortPlatformSupported()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
  it.each([
    { to: "postgres" },
    { to: "sqlite" },
    { to: "postgres", dryRun: true },
    { resume: "missing-manifest.json" },
    { rollback: "missing-manifest.json" },
  ] satisfies DatabasePortOptions[])(
    "refuses with supported alternatives before touching files (%j)",
    async (options) => {
      await withOpenClawTestState({ prefix: "database-port-platform-" }, async (state) => {
        await state.writeConfig({ database: { engine: "sqlite" } });
        const database = await state.writeText("state/openclaw.sqlite", "retained state bytes");
        const configBefore = await fs.readFile(state.configPath);
        const filesBefore = await fs.readdir(state.stateDir, { recursive: true });
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
        expect(await fs.readdir(state.stateDir, { recursive: true })).toEqual(filesBefore);
      });
    },
  );
});
