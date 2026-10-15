import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

it.each(["missing", "zero-byte"])(
  "preserves a %s database when the local operation refuses before needing config",
  async (kind) => {
    const root = roots.make("openclaw-routing-refusal-");
    const configPath = path.join(root, "openclaw.json");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(databasePath));
    await fs.writeFile(configPath, "{}");
    if (kind === "zero-byte") {
      await fs.writeFile(databasePath, "");
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    const refusal = new Error("Outcome refused before writing");
    await expect(
      runWithLocalStateOwner({
        method: "backup.recordOutcome",
        params: {},
        target: "backup outcome ledger",
        runLocal: async () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    if (kind === "missing") {
      await expect(fs.readFile(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await fs.readFile(databasePath)).toEqual(Buffer.alloc(0));
    }
  },
);
