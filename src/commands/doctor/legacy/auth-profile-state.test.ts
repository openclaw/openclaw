import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authProfileStateKey,
  loadPersistedAuthProfileState,
} from "../../../agents/auth-profiles/state.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { readOpenClawStateKvJson } from "../../../state/openclaw-state-kv.js";
import { resolveLegacyAuthProfileStatePath } from "./auth-profile-paths.js";
import {
  importLegacyAuthProfileStateFileToSqlite,
  legacyAuthProfileStateFileExists,
} from "./auth-profile-state.js";

const AUTH_PROFILE_STATE_KV_SCOPE = "auth-profile-state";

describe("legacy auth profile state migration", () => {
  let stateRoot = "";
  let agentDir = "";

  beforeEach(async () => {
    stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-state-root-"));
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-state-agent-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateRoot);
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    await fs.rm(stateRoot, { recursive: true, force: true });
    await fs.rm(agentDir, { recursive: true, force: true });
  });

  it("imports legacy auth-state.json into SQLite and removes the source", async () => {
    const statePath = resolveLegacyAuthProfileStatePath(agentDir);
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        order: { anthropic: ["anthropic:default"] },
        lastGood: { anthropic: "anthropic:default" },
      })}\n`,
    );

    expect(loadPersistedAuthProfileState(agentDir)).toEqual({});
    expect(legacyAuthProfileStateFileExists(agentDir)).toBe(true);
    expect(importLegacyAuthProfileStateFileToSqlite(agentDir)).toEqual({ imported: true });
    expect(loadPersistedAuthProfileState(agentDir)).toEqual({
      order: { anthropic: ["anthropic:default"] },
      lastGood: { anthropic: "anthropic:default" },
    });

    const sqliteState = readOpenClawStateKvJson(
      AUTH_PROFILE_STATE_KV_SCOPE,
      authProfileStateKey(agentDir),
    );
    expect(sqliteState).toMatchObject({
      order: { anthropic: ["anthropic:default"] },
      lastGood: { anthropic: "anthropic:default" },
    });
    await expect(fs.access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips when no legacy auth-state.json exists", () => {
    expect(legacyAuthProfileStateFileExists(agentDir)).toBe(false);
    expect(importLegacyAuthProfileStateFileToSqlite(agentDir)).toEqual({ imported: false });
  });
});
