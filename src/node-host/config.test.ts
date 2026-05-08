import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { readOpenClawStateKvJson } from "../state/openclaw-state-kv.js";
import {
  ensureNodeHostConfig,
  importLegacyNodeHostConfigFileToSqlite,
  legacyNodeHostConfigFileExists,
  loadNodeHostConfig,
  saveNodeHostConfig,
} from "./config.js";

const tempRoots: string[] = [];

async function makeTempStateDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-host-config-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("node host config", () => {
  it("stores node host config in SQLite state", async () => {
    const stateDir = await makeTempStateDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    await saveNodeHostConfig(
      {
        version: 1,
        nodeId: "node-1",
        token: "token-1",
        displayName: "Test node",
        gateway: { host: "gateway.local", port: 18443, tls: true },
      },
      env,
    );

    await expect(loadNodeHostConfig(env)).resolves.toEqual({
      version: 1,
      nodeId: "node-1",
      token: "token-1",
      displayName: "Test node",
      gateway: { host: "gateway.local", port: 18443, tls: true },
    });
    expect(readOpenClawStateKvJson("node-host.config", "current", { env })).toMatchObject({
      nodeId: "node-1",
      token: "token-1",
    });
    await expect(fs.stat(path.join(stateDir, "node.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates a stable SQLite-backed node id on ensure", async () => {
    const stateDir = await makeTempStateDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    const first = await ensureNodeHostConfig(env);
    const second = await ensureNodeHostConfig(env);

    expect(first.nodeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(second.nodeId).toBe(first.nodeId);
  });

  it("imports legacy node.json through doctor migration helpers", async () => {
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
});
