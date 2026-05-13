import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadNodeHostConfig } from "../../../node-host/config.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import {
  importLegacyNodeHostConfigFileToSqlite,
  legacyNodeHostConfigFileExists,
} from "./node-host-config.js";

const tempRoots: string[] = [];

async function makeTempStateDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-node-host-config-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("legacy node host config migration", () => {
  it("imports legacy node.json into SQLite and removes the source", async () => {
    const stateDir = await makeTempStateDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const legacyPath = path.join(stateDir, "node.json");
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        nodeId: "legacy-node",
        token: "legacy-token",
        displayName: "Legacy node",
      })}\n`,
      "utf8",
    );

    await expect(legacyNodeHostConfigFileExists(env)).resolves.toBe(true);
    await expect(importLegacyNodeHostConfigFileToSqlite(env)).resolves.toEqual({
      imported: true,
    });

    await expect(loadNodeHostConfig(env)).resolves.toMatchObject({
      nodeId: "legacy-node",
      token: "legacy-token",
      displayName: "Legacy node",
    });
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips when the legacy node host config is missing", async () => {
    const stateDir = await makeTempStateDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    await expect(legacyNodeHostConfigFileExists(env)).resolves.toBe(false);
    await expect(importLegacyNodeHostConfigFileToSqlite(env)).resolves.toEqual({
      imported: false,
    });
  });
});
