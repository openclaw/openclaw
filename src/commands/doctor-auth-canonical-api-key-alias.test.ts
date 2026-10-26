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
const unchanged = {
  changes: [],
  findings: [],
  aliasFindings: [],
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

function writeProfiles(
  profile: Record<string, unknown>,
  agentDir = state.agentDir(),
  order = false,
) {
  return writeSource(
    JSON.stringify({
      version: 1,
      profiles: { "my-key": { type: "api_key", provider: "my-provider", ...profile } },
      ...(order ? { order: { "my-provider": ["my-key"] } } : {}),
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

it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
  ["inline snake-case key", { api_key: key }, { key }],
  ["snake-case SecretRef", { api_key: secretRef }, { keyRef: secretRef }],
  ["canonical key wins", { key, api_key: stale }, { key }],
  ["canonical keyRef wins", { keyRef: secretRef, api_key: stale }, { keyRef: secretRef }],
  ["canonical inline SecretRef wins", { key: secretRef, api_key: stale }, { keyRef: secretRef }],
])("preserves %s and archives untouched source bytes", async (_name, profile, expected) => {
  const authPath = writeProfiles(profile, state.agentDir(), true);
  const original = fs.readFileSync(authPath);
  const prompter = { confirmAutoFix: vi.fn(async () => true) };

  const result = await migrate(state.env, prompter);

  expect(result).toMatchObject({ detected: [authPath], warnings: [] });
  expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
    profiles: { "my-key": { type: "api_key", provider: "my-provider", ...expected } },
    order: { "my-provider": ["my-key"] },
  });
  expect(fs.existsSync(authPath)).toBe(false);
  expect(archiveBytes(authPath)).toEqual([original]);

  expect(await migrate(state.env, prompter)).toEqual({ detected: [], ...unchanged });
  expect(prompter.confirmAutoFix).toHaveBeenCalledOnce();
});

it.each(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const)(
  "migrates aliases from the shipped %s agent override",
  async (agentDirVariable) => {
    const agentDir = state.path(`external-${agentDirVariable.toLowerCase()}`);
    const authPath = writeProfiles({ api_key: "fake-external-key" }, agentDir);

    const result = await migrate({ ...state.env, [agentDirVariable]: agentDir });

    expect(result.detected).toEqual([authPath]);
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["my-key"]).toMatchObject({
      key: "fake-external-key",
    });
    expect(fs.existsSync(authPath)).toBe(false);
  },
);

it("leaves original credentials untouched when interactive repair is declined", async () => {
  const authPath = writeProfiles({ api_key: "fake-declined-key" });
  const original = fs.readFileSync(authPath);

  const result = await migrate(state.env, { confirmAutoFix: async () => false });

  expect(result).toEqual({ detected: [authPath], ...unchanged });
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

it.each([original, "unparseable legacy auth"])(
  "reuses one archive across repeated identical source reappearances (%#)",
  async (bytes) => {
    const source = await archivedSource(bytes);
    const first = archives(source);
    for (let run = 0; run < 3; run++) {
      await reappear(source, bytes);
      expect(archives(source)).toEqual(first);
      expect(archiveBytes(source)).toEqual([Buffer.from(bytes)]);
    }
  },
);

it.each(["missing", "corrupt", "directory", "symlink"])(
  "preserves bytes and reuses the replacement when the original archive is %s",
  async (damage) => {
    const source = await archivedSource();
    const first = archives(source)[0]!;
    fs.unlinkSync(first);
    if (damage === "corrupt") {
      fs.writeFileSync(first, "corrupt archive");
    } else if (damage === "directory") {
      fs.mkdirSync(first);
    } else if (damage === "symlink") {
      fs.symlinkSync(source, first);
    }
    for (let run = 0; run < 3; run++) {
      await reappear(source);
      const replacements = archives(source).filter((name) => name !== first);
      expect(replacements).toHaveLength(1);
      expect(fs.readFileSync(replacements[0]!, "utf8")).toBe(original);
    }
  },
);

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
