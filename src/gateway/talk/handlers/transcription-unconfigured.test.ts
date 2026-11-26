import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../../plugins/capability-provider.types.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { createTalkHandlerCaller } from "./handler-invocation.test-support.js";
import { expectRespondError } from "./responses.test-support.js";
import { talkSessionHandlers } from "./session.js";

const unconfiguredProvider = (id: string): RealtimeTranscriptionProviderPlugin => ({
  id,
  label: id,
  isConfigured: () => false,
  isConfiguredAsync: async () => false,
  createSession: () => {
    throw new Error("not used");
  },
});

describe("talk.session.create transcription diagnostics", () => {
  it("reports registered but unconfigured providers as unconfigured", async () => {
    const registry = createEmptyPluginRegistry();
    for (const provider of [unconfiguredProvider("deepgram"), unconfiguredProvider("elevenlabs")]) {
      registry.realtimeTranscriptionProviders.push({
        pluginId: provider.id,
        source: "test",
        provider,
      });
    }

    await withPluginRuntimeGenerationScope(
      {
        pluginRegistry: registry,
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: registry.realtimeTranscriptionProviders.map(({ pluginId, provider }) => ({
            id: pluginId,
            contracts: { realtimeTranscriptionProviders: [provider.id] },
          })),
        }),
      },
      async () => {
        const respond = vi.fn();
        await createTalkHandlerCaller(talkSessionHandlers)("talk.session.create", {
          params: { mode: "transcription", transport: "gateway-relay", brain: "none" },
          respond,
          context: {
            getRuntimeConfig: () => ({}) as OpenClawConfig,
            logGateway: { warn: vi.fn() },
          },
        });

        expectRespondError(respond, {
          code: ErrorCodes.UNAVAILABLE,
          message: expect.stringContaining(
            "No realtime transcription provider is configured; check Voice Call streaming credentials",
          ),
        });
        expect(JSON.stringify(respond.mock.calls)).not.toContain("registered");
      },
    );
  });
});
