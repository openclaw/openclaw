import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import "./runtime-discord.test-support.ts";
import { getPath } from "./path-utils.js";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
type PrepareOptions = Omit<Parameters<typeof prepareSecretsRuntimeSnapshot>[0], "config">;
type Snapshot = Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>;
const ref = (id: string) => ({ source: "env", provider: "default", id }) as const;
const voiceTts = (id: string, enabled?: boolean) => ({
  ...(enabled === undefined ? {} : { enabled }),
  tts: { providers: { openai: { apiKey: ref(id) } } },
});
const ttsPath = "voice.tts.providers.openai.apiKey";

function prepare(discord: unknown, options: PrepareOptions = {}, config = {}) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig({ ...config, channels: { discord } }),
    agentDirs: ["/tmp/openclaw-agent-main"],
    loadAuthStore: () => loadAuthStoreWithProfiles({}),
    ...options,
  });
}
function expectFields(
  snapshot: Snapshot,
  fields: Record<string, unknown>,
  inactive: string[] = [],
) {
  for (const [field, value] of Object.entries(fields)) {
    expect(getPath(snapshot.config.channels?.discord, field.split(".")), field).toEqual(value);
  }
  for (const field of inactive) {
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(`channels.discord.${field}`);
  }
}

it.each([false, true])("resolves default token with explicit account=%s", async (explicit) => {
  const snapshot = await prepare(
    {
      token: ref("DISCORD_BOT_TOKEN"),
      ...(explicit
        ? { accounts: { default: { enabled: true, token: ref("DISCORD_DEFAULT_ACCOUNT_TOKEN") } } }
        : {}),
    },
    {
      env: {
        DISCORD_BOT_TOKEN: "base-token",
        ...(explicit ? { DISCORD_DEFAULT_ACCOUNT_TOKEN: "default-account-token" } : {}),
      },
    },
  );
  expectFields(
    snapshot,
    explicit
      ? { token: ref("DISCORD_BOT_TOKEN"), "accounts.default.token": "default-account-token" }
      : { token: "base-token" },
  );
});

it.skipIf(process.platform === "win32")(
  "resolves implicit default alongside named accounts",
  async () => {
    await withTestDir({ prefix: "openclaw-discord-secrets-" }, async (root) => {
      const secretsPath = path.join(root, "secrets.json");
      await fs.writeFile(
        secretsPath,
        JSON.stringify({
          discord: { defaultToken: "default-account-token", secondToken: "second-account-token" },
        }),
        "utf8",
      );
      await fs.chmod(secretsPath, 0o600);
      const fileRef = (id: string) => ({
        source: "file",
        provider: "discord_file",
        id: `/discord/${id}Token`,
      });
      const snapshot = await prepare(
        {
          token: fileRef("default"),
          accounts: { second: { enabled: true, token: fileRef("second") } },
        },
        {},
        {
          secrets: {
            providers: { discord_file: { source: "file", path: secretsPath, mode: "json" } },
          },
        },
      );
      expectFields(snapshot, {
        token: "default-account-token",
        "accounts.second.token": "second-account-token",
      });
      expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
        "channels.discord.token",
      );
    });
  },
);

it("keeps inherited refs active for an env-backed implicit default", async () => {
  const snapshot = await prepare(
    {
      pluralkit: { token: ref("DISCORD_DEFAULT_PK_TOKEN") },
      accounts: { second: { pluralkit: { token: ref("DISCORD_SECOND_PK_TOKEN") } } },
    },
    {
      env: {
        DISCORD_BOT_TOKEN: "env-default-token",
        DISCORD_DEFAULT_PK_TOKEN: "default-pk-token",
        DISCORD_SECOND_PK_TOKEN: "second-pk-token",
      },
    },
  );
  expectFields(snapshot, {
    "pluralkit.token": "default-pk-token",
    "accounts.second.pluralkit.token": "second-pk-token",
  });
  expect(snapshot.warnings).toStrictEqual([]);
});

it("fails when non-default account inherits an unresolved token", async () => {
  await expect(
    prepare(
      { token: ref("MISSING_DISCORD_BASE_TOKEN"), accounts: { work: { enabled: true } } },
      { env: {} },
    ),
  ).rejects.toThrow('Environment variable "MISSING_DISCORD_BASE_TOKEN" is missing or empty.');
});

it("isolates an unresolved account while resolving its sibling", async () => {
  const snapshot = await prepare(
    {
      accounts: {
        broken: { enabled: true, token: ref("MISSING_DISCORD_BROKEN_TOKEN") },
        healthy: { enabled: true, token: ref("DISCORD_HEALTHY_TOKEN") },
      },
    },
    { env: { DISCORD_HEALTHY_TOKEN: "fixture-value" }, allowUnavailableSecretOwners: true },
  );
  expectFields(snapshot, {
    "accounts.broken.token": ref("MISSING_DISCORD_BROKEN_TOKEN"),
    "accounts.healthy.token": "fixture-value",
  });
  expect(snapshot.degradedOwners).toMatchObject([
    {
      ownerKind: "account",
      ownerId: "discord:broken",
      state: "unavailable",
      paths: ["channels.discord.accounts.broken.token"],
      reason: "secret reference was not found",
    },
  ]);
});

it.each([
  [
    "token",
    "MISSING_DISCORD_DEFAULT_TOKEN",
    {
      token: ref("MISSING_DISCORD_DEFAULT_TOKEN"),
      accounts: { default: { enabled: true, token: "" } },
    },
  ],
  [
    "pluralkit.token",
    "MISSING_DISCORD_PLURALKIT_TOKEN",
    { pluralkit: { enabled: false, token: ref("MISSING_DISCORD_PLURALKIT_TOKEN") } },
  ],
] as const)("ignores inactive %s", async (field, id, config) => {
  expectFields(await prepare(config, { env: {} }), { [field]: ref(id) }, [field]);
});

it.each([true, false])("resolves persona refs with root inheritance=%s", async (inheritsRoot) => {
  const voice = (id: string, enabled = true) => ({
    enabled,
    mode: "stt-tts",
    tts: {
      persona: "reader.uk",
      personas: { "reader.uk": { providers: { mock: { apiKey: ref(id) } } } },
    },
    realtime: { providers: { openai: { apiKey: ref(`${id}_REALTIME`) } } },
  });
  const snapshot = await prepare(
    {
      voice: voice("TEST_TTS_DISCORD_ROOT"),
      accounts: {
        ...(inheritsRoot ? { inherited: {} } : {}),
        work: { voice: voice("TEST_TTS_DISCORD_WORK") },
        disabled: { enabled: false, voice: voice("TEST_TTS_DISCORD_DISABLED") },
        muted: { voice: voice("TEST_TTS_DISCORD_MUTED", false) },
      },
    },
    {
      env: {
        ...(inheritsRoot ? { TEST_TTS_DISCORD_ROOT: "root-fixture-key" } : {}),
        TEST_TTS_DISCORD_WORK: "work-fixture-key",
      },
      includeAuthStoreRefs: false,
      loadAuthStore: undefined,
    },
  );
  const discord = snapshot.config.channels?.discord;
  const persona = (value: NonNullable<typeof discord>["voice"]) =>
    value?.tts?.personas?.["reader.uk"]?.providers?.mock?.apiKey;
  expect(persona(discord?.voice)).toEqual(
    inheritsRoot ? "root-fixture-key" : ref("TEST_TTS_DISCORD_ROOT"),
  );
  expect(persona(discord?.accounts?.work?.voice)).toBe("work-fixture-key");
  const inactive = snapshot.warnings
    .filter(({ code }) => code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")
    .map((warning) => warning.path);
  for (const [account, id] of [
    ["disabled", "TEST_TTS_DISCORD_DISABLED"],
    ["muted", "TEST_TTS_DISCORD_MUTED"],
  ] as const) {
    expect(persona(discord?.accounts?.[account]?.voice)).toEqual(ref(id));
    expect(inactive).toContain(
      `channels.discord.accounts.${account}.voice.tts.personas["reader.uk"].providers.mock.apiKey`,
    );
  }
  expect(
    inactive.includes('channels.discord.voice.tts.personas["reader.uk"].providers.mock.apiKey'),
  ).toBe(!inheritsRoot);
  expectFields(
    snapshot,
    {
      "accounts.work.voice.realtime.providers.openai.apiKey": ref("TEST_TTS_DISCORD_WORK_REALTIME"),
    },
    ["accounts.work.voice.realtime.providers.openai.apiKey"],
  );
  expect(snapshot.degradedOwners).toEqual([]);
});

it("ignores TTS refs when voice is disabled", async () => {
  const snapshot = await prepare(
    {
      voice: voiceTts("MISSING_DISCORD_VOICE_TTS_OPENAI", false),
      accounts: {
        work: { enabled: true, voice: voiceTts("MISSING_DISCORD_WORK_VOICE_TTS_OPENAI", false) },
      },
    },
    { env: {} },
  );
  expectFields(
    snapshot,
    {
      [ttsPath]: ref("MISSING_DISCORD_VOICE_TTS_OPENAI"),
      [`accounts.work.${ttsPath}`]: ref("MISSING_DISCORD_WORK_VOICE_TTS_OPENAI"),
    },
    [ttsPath, `accounts.work.${ttsPath}`],
  );
});

it("handles nested inheritance for enabled and disabled accounts", async () => {
  const snapshot = await prepare(
    {
      voice: voiceTts("DISCORD_BASE_TTS_OPENAI"),
      pluralkit: { token: ref("DISCORD_BASE_PK_TOKEN") },
      accounts: {
        enabledInherited: { enabled: true },
        enabledOverride: { enabled: true, voice: voiceTts("DISCORD_ENABLED_OVERRIDE_TTS_OPENAI") },
        disabledOverride: {
          enabled: false,
          voice: voiceTts("DISCORD_DISABLED_OVERRIDE_TTS_OPENAI"),
          pluralkit: { token: ref("DISCORD_DISABLED_OVERRIDE_PK_TOKEN") },
        },
      },
    },
    {
      env: {
        DISCORD_BASE_TTS_OPENAI: "base-tts-openai",
        DISCORD_BASE_PK_TOKEN: "base-pk-token",
        DISCORD_ENABLED_OVERRIDE_TTS_OPENAI: "enabled-override-tts-openai",
      },
    },
  );
  expectFields(
    snapshot,
    {
      [ttsPath]: "base-tts-openai",
      "pluralkit.token": "base-pk-token",
      [`accounts.enabledOverride.${ttsPath}`]: "enabled-override-tts-openai",
      [`accounts.disabledOverride.${ttsPath}`]: ref("DISCORD_DISABLED_OVERRIDE_TTS_OPENAI"),
      "accounts.disabledOverride.pluralkit.token": ref("DISCORD_DISABLED_OVERRIDE_PK_TOKEN"),
    },
    [`accounts.disabledOverride.${ttsPath}`, "accounts.disabledOverride.pluralkit.token"],
  );
});

it("ignores root voice when every enabled account overrides it", async () => {
  const snapshot = await prepare(
    {
      voice: voiceTts("DISCORD_UNUSED_BASE_TTS_OPENAI"),
      accounts: {
        enabledOverride: { enabled: true, voice: voiceTts("DISCORD_ENABLED_ONLY_TTS_OPENAI") },
        disabledInherited: { enabled: false },
      },
    },
    { env: { DISCORD_ENABLED_ONLY_TTS_OPENAI: "enabled-only-tts-openai" } },
  );
  expectFields(
    snapshot,
    {
      [ttsPath]: ref("DISCORD_UNUSED_BASE_TTS_OPENAI"),
      [`accounts.enabledOverride.${ttsPath}`]: "enabled-only-tts-openai",
    },
    [ttsPath],
  );
});

it("degrades an unresolved nested account TTS override", async () => {
  const snapshot = await prepare(
    {
      voice: voiceTts("DISCORD_BASE_TTS_OK"),
      accounts: {
        enabledOverride: { enabled: true, voice: voiceTts("DISCORD_ENABLED_OVERRIDE_TTS_MISSING") },
      },
    },
    { env: { DISCORD_BASE_TTS_OK: "base-tts-openai" }, allowUnavailableSecretOwners: true },
  );
  expectFields(snapshot, {
    [ttsPath]: ref("DISCORD_BASE_TTS_OK"),
    [`accounts.enabledOverride.${ttsPath}`]: ref("DISCORD_ENABLED_OVERRIDE_TTS_MISSING"),
  });
  expect(snapshot.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "SECRETS_OWNER_UNAVAILABLE",
        path: `channels.discord.accounts.enabledOverride.${ttsPath}`,
      }),
    ]),
  );
  expect(
    snapshot.warnings.find(({ code }) => code === "SECRETS_OWNER_UNAVAILABLE")?.message,
  ).toContain("secret reference was not found");
});
