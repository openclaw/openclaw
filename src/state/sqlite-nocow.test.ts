import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeStateDatabaseForTest();
});

it("prepares both store directories before SQLite creates files and skips existing stores", async () => {
  const root = fs.realpathSync(tempDirs.make("openclaw-nocow-open-"));
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const nativeStatfs = fs.statfsSync(root);
    vi.spyOn(fs, "statfsSync").mockReturnValue(Object.assign(nativeStatfs, { type: 0x9123683e }));
    const prepared = new Set<string>();
    const chattr = vi.spyOn(childProcess, "spawnSync").mockImplementation((command, args) => {
      expect(command).toBe("chattr");
      expect(args?.[0]).toBe("+C");
      const directory = String(args?.[1]);
      expect(fs.statSync(directory).isDirectory()).toBe(true);
      expect(fs.readdirSync(directory).filter((name) => name.endsWith(".sqlite"))).toEqual([]);
      prepared.add(directory);
      return { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
    });
    const state = openOpenClawStateDatabase();
    const agent = openOpenClawAgentDatabase({ agentId: "main" });
    expect(prepared).toEqual(new Set([path.dirname(state.path), path.dirname(agent.path)]));
    expect(state.db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(agent.db.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    await closeOpenClawAgentDatabasesAsync();
    await closeStateDatabaseForTest();
    chattr.mockClear();
    openOpenClawStateDatabase();
    openOpenClawAgentDatabase({ agentId: "main" });
    expect(chattr).not.toHaveBeenCalled();
  });
});
