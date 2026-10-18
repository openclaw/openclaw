import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";
import { makePrompter } from "./doctor-auth-flat-profiles.test-support.js";

const states: OpenClawTestState[] = [];

async function makeTestState(): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-reappeared-auth-",
    env: { OPENCLAW_AGENT_DIR: undefined },
  });
  states.push(state);
  return state;
}

async function writeLegacyAuthProfilesJson(state: OpenClawTestState): Promise<string> {
  return await state.writeText(
    "agents/main/agent/auth-profiles.json",
    `${JSON.stringify(
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "synthetic-reappeared-source-key",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function migrateAuthProfiles(state: OpenClawTestState) {
  return maybeMigrateAuthProfileJsonStoresToSqlite({
    cfg: {},
    prompter: makePrompter(true),
    env: state.env,
  });
}

function listMigratedArchives(sourcePath: string): string[] {
  const prefix = `${path.basename(sourcePath)}.migrated-`;
  return fs
    .readdirSync(path.dirname(sourcePath))
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(path.dirname(sourcePath), entry));
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("reappeared legacy auth profile sources", () => {
  it("reuses a verified terminal archive without minting another archive", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state);
    const sourceBytes = fs.readFileSync(authPath);
    await migrateAuthProfiles(state);
    const [archivePath] = listMigratedArchives(authPath);
    expect(archivePath).toBeDefined();
    expect(fs.readFileSync(archivePath!)).toEqual(sourceBytes);

    fs.writeFileSync(authPath, sourceBytes);
    const repaired = await migrateAuthProfiles(state);

    expect(fs.existsSync(authPath)).toBe(false);
    expect(listMigratedArchives(authPath)).toEqual([archivePath]);
    expect(fs.readFileSync(archivePath!)).toEqual(sourceBytes);
    expect(repaired.changes).toEqual([expect.stringContaining("existing archive was verified")]);
  });

  it.each(["missing", "unreadable", "mismatched"] as const)(
    "keeps a source recoverable when its recorded archive is %s",
    async (archiveState) => {
      const state = await makeTestState();
      const authPath = await writeLegacyAuthProfilesJson(state);
      const sourceBytes = fs.readFileSync(authPath);
      await migrateAuthProfiles(state);
      const [archivePath] = listMigratedArchives(authPath);
      expect(archivePath).toBeDefined();
      if (archiveState === "missing") {
        fs.rmSync(archivePath!);
      } else if (archiveState === "unreadable") {
        fs.rmSync(archivePath!);
        fs.mkdirSync(archivePath!);
      } else {
        fs.appendFileSync(archivePath!, "tampered");
      }

      fs.writeFileSync(authPath, sourceBytes);
      const repaired = await migrateAuthProfiles(state);

      expect(fs.existsSync(authPath)).toBe(false);
      const matchingArchives = listMigratedArchives(authPath).filter((candidate) => {
        try {
          return fs.statSync(candidate).isFile() && fs.readFileSync(candidate).equals(sourceBytes);
        } catch {
          return false;
        }
      });
      expect(matchingArchives).toHaveLength(1);
      expect(matchingArchives[0]).not.toBe(archivePath);
      expect(repaired.changes).toEqual([
        expect.stringContaining("Archived a previously migrated legacy auth source"),
      ]);
    },
  );
});
