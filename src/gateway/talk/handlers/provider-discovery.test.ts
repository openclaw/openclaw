import { afterAll, afterEach, describe, expect, it } from "vitest";
import { preparePluginMetadataMachineStateAsync } from "../../../plugins/installed-plugin-index-record-state.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPluginsForTest,
  resetPluginLoaderTestStateForTest,
} from "../../../plugins/loader.test-fixtures.js";
import { createVoiceProviderFixture } from "../../../talk/provider-discovery.test-fixtures.js";
import { listRealtimeVoiceProvidersAsync } from "../../../talk/provider-registry.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { callGatewayHandler } from "../../server-methods/skills.test-helpers.js";
import { talkHandlers } from "./index.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

describe("Talk catalog provider discovery", () => {
  it("includes configured realtime candidates missing from the active registry", async () => {
    const { cfg, env } = createVoiceProviderFixture();
    cfg.talk = { realtime: { providers: { "configured-voice": { ready: true } } } };
    await withEnvAsync(env, async () => {
      await preparePluginMetadataMachineStateAsync({ env });
      const registry = loadOpenClawPluginsForTest({ config: cfg, onlyPluginIds: ["active-voice"] });
      const result = await callGatewayHandler(
        talkHandlers,
        "talk.catalog",
        {},
        {
          context: { getRuntimeConfig: () => cfg },
        },
      );

      expect(result).toMatchObject({
        ok: true,
        error: undefined,
        response: {
          realtime: {
            ready: true,
            activeProvider: "configured-voice",
            providers: [
              { id: "active-voice", configured: false },
              { id: "configured-voice", configured: true },
            ],
          },
        },
      });
      expect((await listRealtimeVoiceProvidersAsync(cfg)).map((provider) => provider.id)).toEqual([
        "active-voice",
        "configured-voice",
      ]);
      expect(registry.realtimeVoiceProviders.map((entry) => entry.provider.id)).toEqual([
        "active-voice",
      ]);
    });
  });
});
