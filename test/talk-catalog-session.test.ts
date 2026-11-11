// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { openaiMediaUnderstandingProvider } from "../extensions/openai/api.js";
import { replaceSessionEntrySync } from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { sessionReadHandlers } from "../src/gateway/server-methods/sessions-read.js";
import { callGatewayHandler } from "../src/gateway/server-methods/skills.test-helpers.js";
import { bindSessionRowProjection } from "../src/gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../src/gateway/session-row-projection.js";
import { roleClient, rolePolicyConfig } from "../src/gateway/session-sharing.test-utils.js";
import { talkHandlers } from "../src/gateway/talk/handlers/index.js";
import { createPluginMetadataSnapshotFixture } from "../src/plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../src/plugins/runtime/generation-scope.js";
import { captureGatewayRootWorkReleaseObserver } from "../src/process/gateway-work-admission.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { createDeferred } from "./helpers/promise.js";

const sessionKey = "agent:researcher:catalog";

it.each([false, true])(
  "uses the selected agent's transcription credentials (selected credentials: %s)",
  async (selectedHasCredentials) => {
    await withOpenClawTestState(
      {
        label: "talk-catalog-session",
        prepareProfileCatalog: true,
        env: { OPENAI_API_KEY: undefined },
      },
      async (state) => {
        const config: OpenClawConfig = {
          ...rolePolicyConfig(),
          agents: {
            ownership: "explicit",
            entries: {
              main: {},
              speaker: {},
              researcher: { workspace: state.workspaceDir },
            },
          },
          talk: { agentId: "speaker" },
          tools: {
            media: {
              audio: { enabled: true },
              models: [{ provider: "openai", model: "whisper-1", capabilities: ["audio"] }],
            },
          },
        };
        await state.writeConfig(config);
        for (const agentId of ["speaker", "researcher"]) {
          const configured =
            agentId === "researcher" ? selectedHasCredentials : !selectedHasCredentials;
          const profile = {
            type: "api_key",
            provider: "openai",
            key: `synthetic-${agentId}-key`,
          };
          await state.writeAuthProfiles(
            { version: 1, profiles: configured ? { "openai:audio": profile } : {} },
            agentId,
          );
        }
        const client = roleClient("view", "catalog-reader");
        const ownerId = roleClient("write", "catalog-owner").authenticatedUserProfile!.profileId;
        for (const [key, visibility] of [
          [sessionKey, "shared"],
          ["agent:researcher:hidden", "draft"],
        ] as const) {
          replaceSessionEntrySync(
            { agentId: "researcher", sessionKey: key },
            {
              sessionId: key,
              updatedAt: 1,
              visibility,
              createdActor: { type: "human", source: "profile", id: ownerId },
            },
          );
        }
        const projection = await createSessionRowProjection({ cfg: config });
        const context = bindSessionRowProjection(
          { getRuntimeConfig: () => config },
          () => projection,
        );
        let catalogReleased = createDeferred<"settled" | "reset">();
        const registry = createEmptyPluginRegistry();
        registry.mediaUnderstandingProviders.push({
          pluginId: "openai",
          source: "test",
          provider: openaiMediaUnderstandingProvider,
        });
        registry.speechProviders.push({
          pluginId: "sample",
          source: "test",
          provider: {
            id: "sample",
            label: "Sample speech",
            isConfigured: () => false,
            isConfiguredAsync: async () => {
              expectDefined(
                captureGatewayRootWorkReleaseObserver(),
                "catalog refresh must own root work admission",
              )(catalogReleased.resolve);
              return false;
            },
            synthesize: async () => {
              throw new Error("catalog must not synthesize");
            },
          },
        });
        try {
          await withPluginRuntimeGenerationScope(
            {
              pluginRegistry: registry,
              metadataSnapshot: createPluginMetadataSnapshotFixture({
                plugins: [
                  { id: "openai", contracts: { mediaUnderstandingProviders: ["openai"] } },
                  { id: "sample", contracts: { speechProviders: ["sample"] } },
                ],
              }),
            },
            async () => {
              const call = (method: string, params: Record<string, unknown>) =>
                callGatewayHandler({ ...talkHandlers, ...sessionReadHandlers }, method, params, {
                  client,
                  context,
                });
              for (const [params, configured] of [
                [{ sessionKey }, selectedHasCredentials],
                [{}, !selectedHasCredentials],
              ] as const) {
                catalogReleased = createDeferred<"settled" | "reset">();
                expect(await call("talk.catalog", params)).toMatchObject({
                  ok: false,
                  error: { retryable: true, details: { reason: "talk-catalog-warming" } },
                });
                expect(await catalogReleased.promise).toBe("settled");
                expect(await call("talk.catalog", params)).toMatchObject({
                  ok: true,
                  error: undefined,
                  response: {
                    transcription: {
                      ready: configured,
                      providers: [expect.objectContaining({ id: "openai", configured })],
                    },
                  },
                });
              }
              for (const key of ["agent:researcher:hidden", "agent:researcher:missing"]) {
                const catalog = await call("talk.catalog", { sessionKey: key });
                const resolved = await call("sessions.resolve", { key });
                expect(catalog).toMatchObject({
                  ok: false,
                  response: undefined,
                  error: { message: `No session found: ${key}` },
                });
                expect(catalog.error).toEqual(resolved.error);
              }
            },
          );
        } finally {
          projection.dispose();
        }
      },
    );
  },
);
