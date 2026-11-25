import { expect, it } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { activateSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const ref = (id: string) => ({ source: "env" as const, provider: "default", id });
const providers = (openai: Record<string, unknown>, rest = {}) => ({
  providers: { openai, ...rest },
});
const selection = (openai: Record<string, unknown>, rest = {}) => ({
  provider: "openai",
  ...providers(openai, rest),
});

function prepare(config: unknown, env: NodeJS.ProcessEnv = {}, manifests?: PluginManifestRecord[]) {
  return prepareSecretsRuntimeSnapshot({
    config: asConfig(config),
    env,
    includeAuthStoreRefs: false,
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: new Map(),
    ...(manifests ? { manifestRegistry: { plugins: manifests } } : {}),
  });
}

it.each(["speech", "realtime"] as const)(
  "resolves active %s refs, warns for inactive refs",
  async (surface) => {
    const selected = selection(
      { apiKey: ref("READY_KEY") },
      { unused: { apiKey: ref("UNUSED_KEY") } },
    );
    const snapshot = await prepare(
      { talk: surface === "speech" ? selected : { realtime: selected } },
      { READY_KEY: "ready" },
    );
    const prefix = `talk.${surface === "realtime" ? "realtime." : ""}providers`;
    expect(snapshot.degradedOwners).toEqual([]);
    const paths = snapshot.warnings.map(({ path }) => path);
    expect(paths).toContain(`${prefix}.unused.apiKey`);
    const runtime = surface === "speech" ? snapshot.config.talk : snapshot.config.talk?.realtime;
    expect(runtime?.providers?.openai?.apiKey).toBe("ready");
  },
);

it.each([
  { surface: "speech", canonical: "volcengine", alias: "bytedance", source: "tts" },
  { surface: "realtime", canonical: "xai", alias: "grok-voice", source: "talk.realtime" },
] as const)(
  "resolves $surface capability aliases",
  async ({ surface, canonical, alias, source }) => {
    const aliasProviders =
      surface === "speech"
        ? { [alias]: {} }
        : { [canonical]: { apiKey: ref("MISSING_KEY") }, [alias]: { model: "voice" } };
    const aliasSelection = { provider: alias, providers: aliasProviders };
    const tts =
      surface === "speech"
        ? { providers: { [canonical]: { apiKey: ref("MISSING_KEY") } } }
        : undefined;
    const talk = surface === "speech" ? aliasSelection : { realtime: aliasSelection };
    const plugin = createPluginManifestRecordFixture({
      id: `${canonical}-plugin`,
      contracts: {
        speechProviders: [canonical, alias],
        realtimeVoiceProviders: [canonical, alias],
      },
    });
    const snapshot = await prepare({ tts, talk }, {}, [plugin]);
    const owner = snapshot.degradedOwners?.find(({ ownerId }) => ownerId === `talk:${surface}`);
    expect(owner?.paths).toEqual([`${source}.providers.${canonical}.apiKey`]);
  },
);

it.each([false, true])("inherits TTS key unless overridden (%s)", async (override) => {
  const snapshot = await prepare(
    {
      tts: providers({ apiKey: ref("MISSING_GLOBAL_KEY") }),
      talk: selection(override ? { apiKey: ref("TALK_KEY") } : {}),
    },
    override ? { TALK_KEY: "healthy" } : {},
  );
  expect(snapshot.degradedOwners?.map(({ ownerId }) => ownerId)).toEqual(
    override ? ["tts"] : ["talk:speech", "tts"],
  );
  expect(snapshot.config.talk?.providers?.openai?.apiKey).toEqual(
    override ? "healthy" : ref("MISSING_GLOBAL_KEY"),
  );
});

it.each([
  ["speech", "shared-talk", "cold", "stale"],
  ["speech", "shared-tts", "stale", "cold"],
  ["speech", "unchanged", "stale", undefined],
  ["realtime", "dormant", "stale", undefined],
  ["speech", "model", "cold", undefined],
  ["realtime", "endpoint", "cold", undefined],
  ["speech", "inherited-endpoint", "cold", undefined],
  ["realtime", "voice-model", "cold", undefined],
] as const)("classifies %s/%s as %s", async (surface, change, state, ttsState) => {
  const key = ref("CURRENT_KEY");
  const config = (candidate: boolean) => {
    const value = (field: string) => (candidate && change === field ? "changed" : "current");
    const selected = selection(
      ttsState
        ? { model: value("shared-talk") }
        : {
            apiKey: key,
            ...(change === "voice-model" ? {} : { model: value("model") }),
            baseUrl: value("endpoint"),
          },
      ttsState ? {} : { dormant: { model: value("dormant") } },
    );
    const tts = ttsState
      ? providers({ apiKey: key }, { dormant: { model: value("shared-tts") } })
      : surface === "speech"
        ? providers({ baseUrl: value("inherited-endpoint") })
        : undefined;
    const agents =
      change === "voice-model"
        ? { defaults: { voiceModel: { primary: `openai/${value("voice-model")}` } } }
        : undefined;
    return { agents, tts, talk: surface === "speech" ? selected : { realtime: selected } };
  };
  const snapshot = await prepare(config(false), { CURRENT_KEY: "last-known-good" });
  activateSecretsRuntimeSnapshotState({ snapshot, refreshContext: null, refreshHandler: null });
  const { config: runtime, degradedOwners } = await prepare(config(true));
  const owners = [{ ownerId: `talk:${surface}`, degradationState: state }];
  if (ttsState) {
    owners.push({ ownerId: "tts", degradationState: ttsState });
    expect(runtime.tts?.providers?.openai?.apiKey).toEqual(
      ttsState === "stale" ? "last-known-good" : key,
    );
  }
  expect(degradedOwners).toMatchObject(owners);
  const talk = surface === "speech" ? runtime.talk : runtime.talk?.realtime;
  expect(talk?.providers?.openai?.apiKey).toEqual(state === "stale" ? "last-known-good" : key);
});
