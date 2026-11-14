import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeMigrateAuthProfileJsonStoresToSqlite } from "./doctor-auth-flat-profiles.js";

let state: OpenClawTestState;
const secretRef = { source: "env", provider: "default", id: "MY_PROVIDER_API_KEY" } as const;
const key = "fake-canonical-key";
const stale = "fake-stale-key";
const migrate = (env: NodeJS.ProcessEnv, prompter = { confirmAutoFix: async () => true }) =>
  maybeMigrateAuthProfileJsonStoresToSqlite({ cfg: {}, prompter, env });

beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-canonical-api-key-",
    env: {
      OPENCLAW_AGENT_DIR: undefined,
      PI_CODING_AGENT_DIR: undefined,
      OPENCLAW_OAUTH_DIR: undefined,
    },
  });
});

function writeSource(bytes: string, agentDir = state.agentDir()) {
  const authPath = path.join(agentDir, "auth-profiles.json");
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, bytes);
  return authPath;
}

function writeProfiles(profile: Record<string, unknown>, agentDir = state.agentDir()) {
  return writeSource(
    JSON.stringify({
      version: 1,
      profiles: { "my-key": { type: "api_key", provider: "my-provider", ...profile } },
      order: { "my-provider": ["my-key"] },
    }) + "\n",
    agentDir,
  );
}

const archives = (source: string) =>
  fs
    .readdirSync(path.dirname(source))
    .filter((name) => name.startsWith("auth-profiles.json.migrated-"))
    .map((name) => path.join(path.dirname(source), name));
const archiveBytes = (source: string) => archives(source).map((name) => fs.readFileSync(name));

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  await state?.cleanup();
});

it.each<[string, Record<string, unknown>, Record<string, unknown>, string?]>([
  ["inline snake-case key", { api_key: key }, { key }],
  ["snake-case SecretRef", { api_key: secretRef }, { keyRef: secretRef }],
  ["canonical key wins", { key, api_key: stale }, { key }],
  ["canonical keyRef wins", { keyRef: secretRef, api_key: stale }, { keyRef: secretRef }],
  ["canonical inline SecretRef wins", { key: secretRef, api_key: stale }, { keyRef: secretRef }],
  ["OPENCLAW_AGENT_DIR", { api_key: key }, { key }, "OPENCLAW_AGENT_DIR"],
  ["PI_CODING_AGENT_DIR", { api_key: key }, { key }, "PI_CODING_AGENT_DIR"],
])("preserves %s and archives source bytes", async (_name, profile, expected, override) => {
  const agentDir = override ? state.path(override) : state.agentDir();
  const env = override ? { ...state.env, [override]: agentDir } : state.env;
  const authPath = writeProfiles(profile, agentDir);
  const original = fs.readFileSync(authPath);
  const prompter = { confirmAutoFix: vi.fn(async () => true) };

  const result = await migrate(env, prompter);

  expect(result).toMatchObject({ detected: [authPath], warnings: [] });
  expect(loadPersistedAuthProfileStore(agentDir)).toMatchObject({
    profiles: { "my-key": { type: "api_key", provider: "my-provider", ...expected } },
    order: { "my-provider": ["my-key"] },
  });
  expect(fs.existsSync(authPath)).toBe(false);
  expect(archiveBytes(authPath)).toEqual([original]);

  expect((await migrate(env, prompter)).changes).toEqual([]);
  expect(prompter.confirmAutoFix).toHaveBeenCalledOnce();
});

it("leaves original credentials untouched when interactive repair is declined", async () => {
  const authPath = writeProfiles({ api_key: "fake-declined-key" });
  const original = fs.readFileSync(authPath);

  const result = await migrate(state.env, { confirmAutoFix: async () => false });

  expect(result).toMatchObject({ detected: [authPath], changes: [], warnings: [] });
  expect(fs.readFileSync(authPath)).toEqual(original);
  expect(loadPersistedAuthProfileStore(state.agentDir())).toBeNull();
});

const profile = { type: "api_key", provider: "archive-proof", key: "synthetic-archive-proof" };
const original = JSON.stringify({ version: 1, profiles: { "archive-proof:default": profile } });

async function archivedSource(bytes = original) {
  const source = writeSource(bytes);
  await migrate(state.env);
  expect(archives(source)).toHaveLength(1);
  return source;
}

async function reappear(source: string, bytes = original) {
  fs.writeFileSync(source, bytes);
  expect((await migrate(state.env)).warnings).toEqual([]);
  expect(fs.existsSync(source)).toBe(false);
}

it.each([
  ["intact", original],
  ["intact", "unparseable legacy auth"],
  ["missing", original],
  ["corrupt", original],
  ["directory", original],
  ["symlink", original],
])("reuses verified bytes after source reappearance (archive=%s, %#)", async (damage, bytes) => {
  const source = await archivedSource(bytes);
  const first = archives(source)[0]!;
  let expected = damage === "intact" ? [first] : undefined;
  if (damage !== "intact") {
    fs.unlinkSync(first);
  }
  if (damage === "corrupt") {
    fs.writeFileSync(first, "corrupt archive");
  } else if (damage === "directory") {
    fs.mkdirSync(first);
  } else if (damage === "symlink") {
    fs.symlinkSync(source, first);
  }
  for (let run = 0; run < 3; run++) {
    await reappear(source, bytes);
    const retained = archives(source).filter((name) => damage === "intact" || name !== first);
    expect(retained).toHaveLength(1);
    expected ??= retained;
    expect(retained).toEqual(expected);
    expect(fs.readFileSync(retained[0]!, "utf8")).toBe(bytes);
  }
});

it("archives changed bytes and imports new profiles without overwriting existing credentials", async () => {
  const source = await archivedSource();
  const changed = JSON.stringify({
    version: 1,
    profiles: {
      "archive-proof:default": { ...profile, key: "synthetic-changed-key" },
      "archive-proof:second": profile,
    },
  });
  await reappear(source, changed);
  expect(archives(source)).toHaveLength(2);
  expect(archiveBytes(source)).toEqual(
    expect.arrayContaining([Buffer.from(original), Buffer.from(changed)]),
  );
  expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toMatchObject({
    "archive-proof:default": profile,
    "archive-proof:second": profile,
  });
});
