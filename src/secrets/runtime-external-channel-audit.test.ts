/** Tests runtime secret auditing for externalized channel plugin surfaces. */
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "../plugins/plugin-metadata.test-support.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { getPath, setPathCreateStrict } from "./path-utils.js";
import {
  assertSecretOwnerAvailable,
  isTrustedSecretSurfaceUnavailableError,
} from "./runtime-degraded-state.js";
import { activateSecretsRuntimeSnapshot } from "./runtime.js";

const {
  getBootstrapChannelSecretsMock,
  loadBundledPublicArtifactMock,
  loadPluginMetadataSnapshotMock,
} = vi.hoisted(() => ({
  getBootstrapChannelSecretsMock: vi.fn(),
  loadBundledPublicArtifactMock: vi.fn(),
  loadPluginMetadataSnapshotMock: vi.fn(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: (params: unknown) =>
    createPluginMetadataSnapshotFixture(loadPluginMetadataSnapshotMock(params)),
  resolvePluginMetadataSnapshot: (params: unknown) => {
    const snapshot = loadPluginMetadataSnapshotMock(params) as { plugins: PluginManifestRecord[] };
    return createPluginMetadataSnapshotFixture({ plugins: snapshot.plugins });
  },
  listPluginOriginsFromMetadataSnapshot: (snapshot: {
    plugins: Array<{ id: string; origin: PluginOrigin }>;
  }) => new Map(snapshot.plugins.map((record) => [record.id, record.origin])),
}));

vi.mock("../plugins/public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadBundledPublicArtifactMock,
}));

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelSecrets: getBootstrapChannelSecretsMock,
}));

import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

const EXTERNALIZED_CHANNEL_IDS = [
  "discord",
  "feishu",
  "msteams",
  "nextcloud-talk",
  "qqbot",
  "zalo",
] as const;

type ExternalizedChannelId = (typeof EXTERNALIZED_CHANNEL_IDS)[number];

function ref(id: string) {
  return { source: "env", provider: "default", id };
}

function createQqBotConfig(accountId = "work") {
  return {
    appId: "qqbot-default-app",
    clientSecret: ref("QQBOT_DEFAULT_SECRET"),
    accounts: {
      [accountId]: { appId: "qqbot-named-app", clientSecret: ref("QQBOT_NAMED_SECRET") },
    },
  };
}

function inactiveExecRef(id: string) {
  return { source: "exec", provider: "vault", id };
}

function createExternalChannelRecord(id: ExternalizedChannelId): PluginManifestRecord {
  const rootDir = path.resolve("extensions", id);
  return createPluginManifestRecordFixture({
    id: id === "qqbot" ? "openclaw-qqbot" : id,
    channels: [id],
    origin: "global",
    rootDir,
  });
}

function configureExternalChannelRecords(
  channelIds: readonly ExternalizedChannelId[] = EXTERNALIZED_CHANNEL_IDS,
): PluginManifestRecord[] {
  const records = channelIds.map((id) => createExternalChannelRecord(id));
  loadPluginMetadataSnapshotMock.mockReturnValue({ plugins: records });
  return records;
}

function externalChannelOrigins(records: readonly PluginManifestRecord[]) {
  return new Map(records.map((record) => [record.id, record.origin] as const));
}

function channelPreparer(
  id: ExternalizedChannelId,
  options: Omit<Parameters<typeof prepareSecretsRuntimeSnapshot>[0], "config" | "env"> = {},
) {
  const records = configureExternalChannelRecords([id]);
  return (channel: unknown, env: NodeJS.ProcessEnv = {}) =>
    prepareSecretsRuntimeSnapshot({
      config: asConfig({ channels: { [id]: channel } }),
      env,
      includeAuthStoreRefs: false,
      loadablePluginOrigins: externalChannelOrigins(records),
      ...options,
    });
}

function expectMetadataBackedContractsWereUsed(
  channelIds: readonly ExternalizedChannelId[] = EXTERNALIZED_CHANNEL_IDS,
) {
  expect(getBootstrapChannelSecretsMock).not.toHaveBeenCalled();
  expect(loadPluginMetadataSnapshotMock).toHaveBeenCalled();
  for (const channelId of channelIds) {
    expect(loadBundledPublicArtifactMock).toHaveBeenCalledWith({
      dirName: channelId,
      artifactCandidates: ["secret-contract-api.js"],
    });
    expect(loadBundledPublicArtifactMock).not.toHaveBeenCalledWith({
      dirName: channelId,
      artifactCandidates: ["contract-api.js"],
    });
  }
}

describe("secrets runtime externalized channel SecretRef audit", () => {
  beforeEach(() => {
    getBootstrapChannelSecretsMock.mockReset();
    getBootstrapChannelSecretsMock.mockReturnValue(undefined);
    loadBundledPublicArtifactMock.mockReset();
    loadBundledPublicArtifactMock.mockReturnValue(null);
    loadPluginMetadataSnapshotMock.mockReset();
  });

  it.each([true, false])("resolves only active channel credentials (active=%s)", async (active) => {
    const records = configureExternalChannelRecords();
    const channels: Record<string, unknown> = {};
    const env: NodeJS.ProcessEnv = {};
    const expected: Record<string, unknown> = {};
    const warningPaths: string[] = [];
    const accountId = active ? "work" : "disabled";
    for (const id of EXTERNALIZED_CHANNEL_IDS) {
      const fields = {
        discord: [
          "token",
          "pluralkit.token",
          ...(active ? ["voice.realtime.providers.openai.apiKey"] : []),
          "voice.tts.providers.openai.apiKey",
        ],
        feishu: ["appSecret", "encryptKey", "verificationToken"],
        msteams: ["appPassword"],
        "nextcloud-talk": ["botSecret", "apiPassword"],
        qqbot: ["clientSecret"],
        zalo: ["botToken", "webhookSecret"],
      }[id];
      const settings: Record<string, unknown> = { enabled: active };
      if (id === "discord") {
        settings.pluralkit = { enabled: true };
        settings.voice = { enabled: true };
      } else if (id === "feishu") {
        settings.connectionMode = "webhook";
      } else if (id === "qqbot") {
        settings.appId = "qqbot-app";
      } else if (id === "zalo") {
        settings.webhookUrl = "https://example.test/zalo";
      }
      const channel = structuredClone(settings);
      const account = structuredClone(settings);
      if (id !== "msteams") {
        channel.accounts = {
          ...(active && id !== "qqbot"
            ? {
                inherited: {
                  enabled: true,
                  ...(id === "feishu" ? { connectionMode: "webhook" } : {}),
                },
              }
            : {}),
          [accountId]: account,
        };
      }
      channels[id] = channel;
      for (const field of fields) {
        for (const [record, prefix] of [
          [channel, `channels.${id}`],
          ...(id === "msteams" ? [] : [[account, `channels.${id}.accounts.${accountId}`] as const]),
        ] as const) {
          const key = `${prefix}.${field}`;
          const refId = key.replaceAll(/[^a-z0-9]/gi, "_").toUpperCase();
          const value = active ? ref(refId) : inactiveExecRef(refId);
          setPathCreateStrict(record, field.split("."), value);
          env[refId] = `synthetic-${refId}`;
          expected[key] = active ? env[refId] : value;
          if (!active) {
            warningPaths.push(key);
          }
        }
      }
    }
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({ channels }),
      env: active ? env : {},
      ...(active
        ? { includeAuthStoreRefs: false }
        : {
            agentDirs: ["/tmp/openclaw-agent-main"],
            loadAuthStore: () => loadAuthStoreWithProfiles({}),
          }),
      loadablePluginOrigins: externalChannelOrigins(records),
    });
    for (const [key, value] of Object.entries(expected)) {
      expect(getPath(snapshot.config, key.split(".")), key).toEqual(value);
    }
    expect(snapshot.warnings.map((warning) => warning.path)).toStrictEqual(warningPaths);
    expectMetadataBackedContractsWereUsed();
  });

  it("resolves Feishu top-level appSecret SecretRef for the implicit default account", async () => {
    const prepare = channelPreparer("feishu");
    const snapshot = await prepare(
      {
        enabled: true,
        appId: "cli_default",
        appSecret: ref("FEISHU_APP_SECRET"),
        accounts: {
          "resource-shrimp": {
            enabled: true,
            appId: "cli_resource",
            appSecret: "inline-secret-here", // pragma: allowlist secret
          },
        },
      },
      { FEISHU_APP_SECRET: "default-secret" },
    );

    expect(snapshot.config.channels?.feishu).toMatchObject({
      appSecret: "default-secret",
      accounts: { "resource-shrimp": { appSecret: "inline-secret-here" } },
    });
    expect(snapshot.warnings).toStrictEqual([]);
    expectMetadataBackedContractsWereUsed(["feishu"]);
  });

  it.each(["default", "named"] as const)(
    "isolates a missing QQBot %s ref without replacing it or blocking its sibling",
    async (missingAccount) => {
      const prepare = channelPreparer("qqbot", { allowUnavailableSecretOwners: true });
      const namedId = missingAccount === "named" ? "Named.Team" : "work";
      const config = createQqBotConfig(namedId);
      const defaultPath = ["clientSecret"];
      const namedPath = ["accounts", namedId, "clientSecret"];
      const missingPath = missingAccount === "default" ? defaultPath : namedPath;
      const healthyPath = missingAccount === "default" ? namedPath : defaultPath;
      const missingRef = getPath(config, missingPath);
      const missingOwner = `qqbot:${missingAccount === "default" ? "default" : "named-team"}`;
      const healthyOwner = `qqbot:${missingAccount === "default" ? "work" : "default"}`;
      const snapshot = await prepare(config, {
        [missingAccount === "default" ? "QQBOT_NAMED_SECRET" : "QQBOT_DEFAULT_SECRET"]:
          "synthetic-healthy-secret",
        QQBOT_CLIENT_SECRET: "synthetic-env-fallback-must-not-win",
      });

      expect(getPath(snapshot.config.channels?.qqbot, missingPath)).toEqual(missingRef);
      expect(getPath(snapshot.config.channels?.qqbot, healthyPath)).toBe(
        "synthetic-healthy-secret",
      );
      expect(snapshot.degradedOwners).toEqual([
        expect.objectContaining({
          ownerKind: "account",
          ownerId: missingOwner,
          state: "unavailable",
          degradationState: "cold",
          paths: [
            missingAccount === "default"
              ? "channels.qqbot.clientSecret"
              : 'channels.qqbot.accounts["Named.Team"].clientSecret',
          ],
        }),
      ]);
      activateSecretsRuntimeSnapshot(snapshot);
      expect(() => assertSecretOwnerAvailable("account", missingOwner)).toThrow(
        "configured but unavailable",
      );
      expect(() => assertSecretOwnerAvailable("account", healthyOwner)).not.toThrow();
      expectMetadataBackedContractsWereUsed(["qqbot"]);
    },
  );

  it.each(["default", "named"] as const)(
    "retains stale QQBot %s credentials only while their own account contract is unchanged",
    async (missingAccount) => {
      const prepare = channelPreparer("qqbot", { allowUnavailableSecretOwners: true });
      const config = createQqBotConfig();
      activateSecretsRuntimeSnapshot(
        await prepare(config, {
          QQBOT_DEFAULT_SECRET: "synthetic-original-default",
          QQBOT_NAMED_SECRET: "synthetic-original-named",
        }),
      );

      const siblingChanged = structuredClone(config);
      if (missingAccount === "default") {
        siblingChanged.accounts.work!.appId = "changed-sibling-app";
      } else {
        siblingChanged.clientSecret = ref("QQBOT_CHANGED_DEFAULT_SECRET");
      }
      const healthyRefId =
        missingAccount === "default" ? "QQBOT_NAMED_SECRET" : "QQBOT_CHANGED_DEFAULT_SECRET";
      const defaultPath = ["clientSecret"];
      const namedPath = ["accounts", "work", "clientSecret"];
      const missingPath = missingAccount === "default" ? defaultPath : namedPath;
      const healthyPath = missingAccount === "default" ? namedPath : defaultPath;
      const missingOwner = `qqbot:${missingAccount === "default" ? "default" : "work"}`;
      const stale = await prepare(siblingChanged, { [healthyRefId]: "synthetic-refreshed-secret" });

      expect(stale.degradedOwners).toEqual([
        expect.objectContaining({ ownerId: missingOwner, degradationState: "stale" }),
      ]);
      expect(getPath(stale.config.channels?.qqbot, missingPath)).toBe(
        `synthetic-original-${missingAccount}`,
      );
      expect(getPath(stale.config.channels?.qqbot, healthyPath)).toBe("synthetic-refreshed-secret");
      activateSecretsRuntimeSnapshot(stale);
      expect(() => assertSecretOwnerAvailable("account", missingOwner)).not.toThrow();

      const ownerChanged = structuredClone(siblingChanged);
      const owner = missingAccount === "default" ? ownerChanged : ownerChanged.accounts.work!;
      owner.appId = "changed-owner-app";
      const cold = await prepare(ownerChanged, { [healthyRefId]: "synthetic-next-secret" });

      expect(cold.degradedOwners).toEqual([
        expect.objectContaining({ ownerId: missingOwner, degradationState: "cold" }),
      ]);
      expect(getPath(cold.config.channels?.qqbot, missingPath)).toEqual(
        getPath(ownerChanged, missingPath),
      );
      expect(getPath(cold.config.channels?.qqbot, healthyPath)).toBe("synthetic-next-secret");
      activateSecretsRuntimeSnapshot(cold);
      expect(() => assertSecretOwnerAvailable("account", missingOwner)).toThrow(
        "configured but unavailable",
      );
      expect(() =>
        assertSecretOwnerAvailable(
          "account",
          `qqbot:${missingAccount === "default" ? "work" : "default"}`,
        ),
      ).not.toThrow();
    },
  );

  it.each([
    { label: "malformed", secret: ref("invalid-lowercase-id"), error: /invalid/i },
    {
      label: "unknown provider",
      secret: { source: "file", provider: "unconfigured", id: "/qqbot/clientSecret" },
      error: /provider/i,
    },
  ])("keeps $label QQBot SecretRefs strict", async ({ secret, error }) => {
    const prepare = channelPreparer("qqbot", { allowUnavailableSecretOwners: true });

    await expect(
      prepare(
        { appId: "qqbot-default-app", clientSecret: secret },
        { QQBOT_CLIENT_SECRET: "synthetic-env-fallback-must-not-win" },
      ),
    ).rejects.toThrow(error);
  });

  it("publishes an unavailable Discord realtime provider owner as a typed redacted error", async () => {
    const prepare = channelPreparer("discord", { allowUnavailableSecretOwners: true });
    const snapshot = await prepare({
      accounts: {
        work: {
          enabled: true,
          voice: {
            enabled: true,
            mode: "agent-proxy",
            realtime: {
              provider: "grok-voice",
              providers: { xai: { apiKey: ref("MISSING_XAI_REALTIME_API_KEY") } },
            },
          },
        },
      },
    });

    expect(snapshot.degradedOwners).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "discord:voice:realtime:work:xai",
        reason: "secret reference was not found",
      },
    ]);
    activateSecretsRuntimeSnapshot(snapshot);

    let failure: unknown;
    try {
      assertSecretOwnerAvailable("capability", "discord:voice:realtime:work:xai");
    } catch (error) {
      failure = error;
    }
    expect(isTrustedSecretSurfaceUnavailableError(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerKind: "capability",
      ownerId: "discord:voice:realtime:work:xai",
      paths: ["channels.discord.accounts.work.voice.realtime.providers.xai.apiKey"],
    });
    expect(String(failure)).not.toContain("MISSING_XAI_REALTIME_API_KEY");
    expectMetadataBackedContractsWereUsed(["discord"]);
  });
});
