// Historical API-key aliases migrate directly into the receipted SQLite auth owner.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";

let state: OpenClawTestState;
const secretRef = { source: "env", provider: "default", id: "MY_PROVIDER_API_KEY" } as const;
const key = "fake-canonical-key";
const stale = "fake-stale-key";
const unchanged = {
  changes: [],
  migratedProfileIds: new Set<string>(),
  blockedProfileIds: new Set<string>(),
  warnings: [],
};
const migrate = (env: NodeJS.ProcessEnv, prompter = { confirmAutoFix: async () => true }) =>
  maybeMigrateAuthProfileJsonStoresToSqlite({ cfg: {}, prompter, env });

beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-canonical-api-key-",
    env: { OPENCLAW_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: undefined },
  });
});

async function writeProfiles(
  profile: Record<string, unknown>,
  options: { agentDir?: string; order?: boolean } = {},
): Promise<string> {
  const authPath = path.join(options.agentDir ?? state.agentDir(), "auth-profiles.json");
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(
    authPath,
    `${JSON.stringify({
      version: 1,
      profiles: { "my-key": { type: "api_key", provider: "my-provider", ...profile } },
      ...(options.order ? { order: { "my-provider": ["my-key"] } } : {}),
    })}\n`,
  );
  return authPath;
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await state?.cleanup();
});

it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
  ["inline snake-case key", { api_key: key }, { key }],
  ["snake-case SecretRef", { api_key: secretRef }, { keyRef: secretRef }],
  ["canonical key wins", { key, api_key: stale }, { key }],
  ["canonical keyRef wins", { keyRef: secretRef, api_key: stale }, { keyRef: secretRef }],
  ["canonical inline SecretRef wins", { key: secretRef, api_key: stale }, { keyRef: secretRef }],
])("preserves %s and archives untouched source bytes", async (_name, profile, expected) => {
  const authPath = await writeProfiles(profile, { order: true });
  const original = fs.readFileSync(authPath);
  const prompter = { confirmAutoFix: vi.fn(async () => true) };

  const result = await migrate(state.env, prompter);

  expect(result).toMatchObject({ detected: [authPath], warnings: [] });
  expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
    profiles: { "my-key": { type: "api_key", provider: "my-provider", ...expected } },
    order: { "my-provider": ["my-key"] },
  });
  expect(fs.existsSync(authPath)).toBe(false);
  const archive = fs
    .readdirSync(path.dirname(authPath))
    .find((entry) => entry.startsWith(`${path.basename(authPath)}.migrated-`));
  expect(archive).toBeDefined();
  expect(fs.readFileSync(path.join(path.dirname(authPath), archive!))).toEqual(original);

  expect(await migrate(state.env, prompter)).toEqual({ detected: [], ...unchanged });
  expect(prompter.confirmAutoFix).toHaveBeenCalledOnce();
});

it.each(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const)(
  "migrates aliases from the shipped %s agent override",
  async (agentDirVariable) => {
    const agentDir = state.path(`external-${agentDirVariable.toLowerCase()}`);
    const authPath = await writeProfiles({ api_key: "fake-external-key" }, { agentDir });

    const result = await migrate({ ...state.env, [agentDirVariable]: agentDir });

    expect(result.detected).toEqual([authPath]);
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["my-key"]).toMatchObject({
      key: "fake-external-key",
    });
    expect(fs.existsSync(authPath)).toBe(false);
  },
);

it("leaves original credentials untouched when interactive repair is declined", async () => {
  const authPath = await writeProfiles({ api_key: "fake-declined-key" });
  const original = fs.readFileSync(authPath);

  const result = await migrate(state.env, { confirmAutoFix: async () => false });

  expect(result).toEqual({ detected: [authPath], ...unchanged });
  expect(fs.readFileSync(authPath)).toEqual(original);
  expect(loadPersistedAuthProfileStore(state.agentDir())).toBeNull();
});
