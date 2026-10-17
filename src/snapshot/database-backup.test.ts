import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runOfflineDatabaseBackup } from "./database-backup.js";

describe("offline database backup admission", () => {
  it.each([false, true])(
    "rejects invalid recovery config before dispatch (archived: %s)",
    async (archived) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          database: {
            engine: "postgres",
            postgres: { connection: "postgresql://127.0.0.1:1/unused" },
          },
          gateway: { port: -1 },
        });
        let configPath: string | undefined;
        if (archived) {
          configPath = state.path("recovered-config.json");
          await fs.copyFile(state.configPath, configPath);
          await state.writeConfig({ database: { engine: "sqlite" } });
        }
        const target = state.path("backup-dispatched");
        await expect(
          runOfflineDatabaseBackup(
            target,
            async () => {
              await fs.writeFile(target, "dispatched");
            },
            configPath ? { configPath } : undefined,
          ),
        ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
        await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});
