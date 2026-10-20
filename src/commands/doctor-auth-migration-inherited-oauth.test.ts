import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";

const states: OpenClawTestState[] = [];
const profileId = "openai:shared@example.test";

function oauthStore(owner: string, expires: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [profileId]: {
        type: "oauth",
        provider: "openai",
        access: `fake-${owner}-access`,
        refresh: `fake-${owner}-refresh`,
        expires: Date.parse(expires),
      },
    },
  };
}

async function makeTestState(): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState();
  states.push(state);
  return state;
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  while (states.length > 0) {
    await states.pop()?.cleanup();
  }
});

describe("auth profile migration with an inherited main OAuth credential", () => {
  it("completes and removes the legacy JSON instead of failing verification", async () => {
    const state = await makeTestState();

    // Main migrated first; the secondary's older copy is inherited, not lost.
    saveAuthProfileStore(oauthStore("main", "2027-01-01T00:00:00.000Z"), state.agentDir(), {
      syncExternalCli: false,
    });

    const secondaryAgentDir = state.agentDir("gadget");
    const secondaryAuthPath = await state.writeText(
      "agents/gadget/agent/auth-profiles.json",
      `${JSON.stringify(oauthStore("stale", "2026-06-20T00:00:00.000Z"), null, 2)}\n`,
    );

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {
        agents: {
          defaults: { authInheritance: { agentId: "main" } },
          entries: { gadget: { agentDir: secondaryAgentDir } },
        },
      },
      prompter: { confirmAutoFix: async () => true },
      env: state.env,
      now: () => Date.parse("2026-07-26T12:00:00.000Z"),
    });

    expect(result.warnings).toStrictEqual([]);
    // A leftover legacy file blocks startup.
    expect(fs.existsSync(secondaryAuthPath)).toBe(false);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles[profileId]).toMatchObject({
      type: "oauth",
      access: "fake-main-access",
    });
  });
});
