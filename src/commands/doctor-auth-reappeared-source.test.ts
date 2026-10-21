import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";

const states: OpenClawTestState[] = [];
const profile = { type: "api_key", provider: "archive-proof", key: "synthetic-archive-proof" };
const original = JSON.stringify({ version: 1, profiles: { "archive-proof:default": profile } });

async function fixture(bytes = original) {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "doctor-auth-reappeared-",
    env: { OPENCLAW_AGENT_DIR: undefined, OPENCLAW_OAUTH_DIR: undefined },
  });
  states.push(state);
  const source = await state.writeText("agents/main/agent/auth-profiles.json", bytes);
  const migrate = () =>
    maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      env: state.env,
      prompter: { confirmAutoFix: async () => true },
    });
  const archives = () =>
    fs
      .readdirSync(path.dirname(source))
      .filter((name) => name.startsWith("auth-profiles.json.migrated-"));
  await migrate();
  expect(archives()).toHaveLength(1);
  return { state, source, migrate, archives };
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

it.each([original, "unparseable legacy auth"])(
  "reuses one archive across repeated identical source reappearances (%#)",
  async (bytes) => {
    const { source, migrate, archives } = await fixture(bytes);
    const first = archives();
    for (let run = 0; run < 3; run++) {
      fs.writeFileSync(source, bytes);
      const result = await migrate();
      expect(result.warnings).toEqual([]);
      expect(fs.existsSync(source)).toBe(false);
      expect(archives()).toEqual(first);
      expect(fs.readFileSync(path.join(path.dirname(source), first[0]!), "utf8")).toBe(bytes);
    }
  },
);

it.each(["missing", "corrupt", "directory", "symlink"])(
  "preserves bytes and reuses the replacement when the original archive is %s",
  async (damage) => {
    const { source, migrate, archives } = await fixture();
    const first = path.join(path.dirname(source), archives()[0]!);
    fs.unlinkSync(first);
    if (damage === "corrupt") {
      fs.writeFileSync(first, "corrupt archive");
    } else if (damage === "directory") {
      fs.mkdirSync(first);
    } else if (damage === "symlink") {
      fs.symlinkSync(source, first);
    }
    for (let run = 0; run < 3; run++) {
      fs.writeFileSync(source, original);
      const result = await migrate();
      expect(result.warnings).toEqual([]);
      expect(fs.existsSync(source)).toBe(false);
      const replacements = archives().filter(
        (name) => path.join(path.dirname(source), name) !== first,
      );
      expect(replacements).toHaveLength(1);
      expect(fs.readFileSync(path.join(path.dirname(source), replacements[0]!), "utf8")).toBe(
        original,
      );
    }
  },
);

it("archives changed bytes and imports new profiles without overwriting existing credentials", async () => {
  const { state, source, migrate, archives } = await fixture();
  const changed = JSON.stringify({
    version: 1,
    profiles: {
      "archive-proof:default": { ...profile, key: "synthetic-changed-key" },
      "archive-proof:second": profile,
    },
  });
  fs.writeFileSync(source, changed);
  const result = await migrate();
  expect(result.warnings).toEqual([]);
  expect(fs.existsSync(source)).toBe(false);
  expect(archives()).toHaveLength(2);
  expect(
    archives().map((name) => fs.readFileSync(path.join(path.dirname(source), name), "utf8")),
  ).toEqual(expect.arrayContaining([original, changed]));
  expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toMatchObject({
    "archive-proof:default": profile,
    "archive-proof:second": profile,
  });
});
