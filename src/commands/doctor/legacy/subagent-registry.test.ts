import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadSubagentRegistryFromState,
  saveSubagentRegistryToState,
} from "../../../agents/subagent-registry.store.js";
import type { SubagentRunRecord } from "../../../agents/subagent-registry.types.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import {
  importLegacySubagentRegistryFileToSqlite,
  legacySubagentRegistryFileExists,
  resolveLegacySubagentRegistryPath,
} from "./subagent-registry.js";

let tempStateDir: string | null = null;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  if (tempStateDir) {
    await fs.rm(tempStateDir, { recursive: true, force: true });
    tempStateDir = null;
  }
});

async function setupStateDir(): Promise<string> {
  tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-subagent-"));
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
  return tempStateDir;
}

async function writeLegacyRegistry(value: unknown): Promise<string> {
  await setupStateDir();
  const registryPath = resolveLegacySubagentRegistryPath(process.env);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, `${JSON.stringify(value)}\n`, "utf8");
  return registryPath;
}

describe("legacy subagent registry migration", () => {
  it("maps legacy announce fields into cleanup state", async () => {
    const registryPath = await writeLegacyRegistry({
      version: 1,
      runs: {
        "run-legacy": {
          runId: "run-legacy",
          childSessionKey: "agent:main:subagent:legacy",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "legacy announce",
          cleanup: "keep",
          createdAt: 1,
          startedAt: 1,
          endedAt: 2,
          announceCompletedAt: 9,
          announceHandled: true,
          requesterChannel: "whatsapp",
          requesterAccountId: "legacy-account",
        },
      },
    });

    expect(legacySubagentRegistryFileExists(process.env)).toBe(true);
    expect(importLegacySubagentRegistryFileToSqlite(process.env)).toEqual({
      imported: true,
      runs: 1,
    });

    const entry = loadSubagentRegistryFromState().get("run-legacy");
    expect(entry?.cleanupHandled).toBe(true);
    expect(entry?.cleanupCompletedAt).toBe(9);
    expect(entry?.requesterOrigin?.channel).toBe("whatsapp");
    expect(entry?.requesterOrigin?.accountId).toBe("legacy-account");
    await expect(fs.access(registryPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(legacySubagentRegistryFileExists(process.env)).toBe(false);
  });

  it("merges legacy registry imports into existing SQLite runs", async () => {
    await setupStateDir();
    const existing: SubagentRunRecord = {
      runId: "run-existing",
      childSessionKey: "agent:main:subagent:existing",
      requesterSessionKey: "agent:main:main",
      controllerSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "existing sqlite run",
      cleanup: "keep",
      createdAt: 1,
      startedAt: 2,
      spawnMode: "run",
    };
    saveSubagentRegistryToState(new Map([[existing.runId, existing]]));

    const registryPath = resolveLegacySubagentRegistryPath(process.env);
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(
      registryPath,
      `${JSON.stringify({
        version: 2,
        runs: {
          "run-imported": {
            runId: "run-imported",
            childSessionKey: "agent:main:subagent:imported",
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "imported legacy run",
            cleanup: "keep",
            createdAt: 3,
            startedAt: 4,
            spawnMode: "run",
          },
        },
      })}\n`,
      "utf8",
    );

    expect(importLegacySubagentRegistryFileToSqlite(process.env)).toEqual({
      imported: true,
      runs: 1,
    });

    const restored = loadSubagentRegistryFromState();
    expect(restored.get("run-existing")).toMatchObject({
      childSessionKey: "agent:main:subagent:existing",
    });
    expect(restored.get("run-imported")).toMatchObject({
      childSessionKey: "agent:main:subagent:imported",
    });
    await expect(fs.access(registryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips when no legacy registry file exists", async () => {
    await setupStateDir();

    expect(legacySubagentRegistryFileExists(process.env)).toBe(false);
    expect(importLegacySubagentRegistryFileToSqlite(process.env)).toEqual({
      imported: false,
      runs: 0,
    });
  });

  it("uses isolated temp state when OPENCLAW_STATE_DIR is unset in tests", () => {
    delete process.env.OPENCLAW_STATE_DIR;
    const registryPath = resolveLegacySubagentRegistryPath();
    expect(registryPath).toContain(path.join(os.tmpdir(), "openclaw-test-state"));
  });
});
