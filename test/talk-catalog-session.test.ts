// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { openaiMediaUnderstandingProvider } from "../extensions/openai/api.js";
import { replaceSessionEntrySync } from "../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { sessionReadHandlers } from "../src/gateway/server-methods/sessions-read.js";
import { bindSessionRowProjection } from "../src/gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../src/gateway/session-row-projection.js";
import { roleClient, rolePolicyConfig } from "../src/gateway/session-sharing.test-utils.js";
import { createTalkHandlerCaller } from "../src/gateway/talk/handlers/handler-invocation.test-support.js";
import { talkHandlers } from "../src/gateway/talk/handlers/index.js";
import {
  expectRespondError,
  expectRespondOk,
} from "../src/gateway/talk/handlers/responses.test-support.js";
import { acquireStateDatabaseSchemaLease } from "../src/infra/gateway-state-owner.js";
import { createPluginMetadataSnapshotFixture } from "../src/plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../src/plugins/runtime/generation-scope.js";
import { createOpenClawDatabaseMaintenanceScope } from "../src/state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../src/state/openclaw-state-db.paths.js";
import { prepareUserProfileCatalog } from "../src/state/user-profile-list.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

const sessionKey = "agent:researcher:catalog";

describe("session-scoped Talk catalog", () => {
  it.each([false, true])(
    "uses the selected agent's transcription credentials (selected credentials: %s)",
    async (selectedHasCredentials) => {
      await withOpenClawTestState(
        { label: "talk-catalog-session", env: { OPENAI_API_KEY: undefined } },
        async (state) => {
          const config: OpenClawConfig = {
            ...rolePolicyConfig(),
            agents: {
              ownership: "explicit",
              entries: {
                main: {},
                speaker: {},
                researcher: {
                  workspace: state.workspaceDir,
                  tts: {
                    providers: {
                      sample: { apiKey: selectedHasCredentials ? "synthetic-speech-key" : "" },
                    },
                  },
                },
              },
            },
            talk: { agentId: "speaker" },
            tts: {
              provider: "sample",
              providers: {
                sample: { apiKey: selectedHasCredentials ? "" : "synthetic-speech-key" },
              },
            },
            tools: {
              media: {
                audio: { enabled: true },
                models: [{ provider: "openai", model: "whisper-1", capabilities: ["audio"] }],
              },
            },
          };
          await state.writeConfig(config);
          const lease = acquireStateDatabaseSchemaLease(resolveOpenClawStateSqlitePath(state.env));
          const maintenance = createOpenClawDatabaseMaintenanceScope({
            schemaMaintenance: true,
            assertOwnerCurrent: lease.assertCurrent,
            assertDatabaseAccess: lease.assertDatabaseAccess,
          });
          const { client, profileCatalog } = await (async () => {
            try {
              return await maintenance.run(async () => {
                for (const agentId of ["speaker", "researcher"]) {
                  const configured =
                    agentId === "researcher" ? selectedHasCredentials : !selectedHasCredentials;
                  await state.writeAuthProfiles(
                    {
                      version: 1,
                      profiles: configured
                        ? {
                            "openai:audio": {
                              type: "api_key",
                              provider: "openai",
                              key: `synthetic-${agentId}-key`,
                            },
                          }
                        : {},
                    },
                    agentId,
                  );
                }
                const preparedProfileCatalog = await prepareUserProfileCatalog();
                const reader = roleClient("view", "catalog-reader");
                const owner = roleClient("write", "catalog-owner");
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
                      createdActor: {
                        type: "human",
                        source: "profile",
                        id: owner.authenticatedUserProfile!.profileId,
                      },
                    },
                  );
                }
                return { client: reader, profileCatalog: preparedProfileCatalog };
              });
            } finally {
              try {
                await maintenance.close();
              } finally {
                lease.release();
              }
            }
          })();
          const projection = await createSessionRowProjection({ cfg: config });
          const context = bindSessionRowProjection(
            { getRuntimeConfig: () => config },
            () => projection,
          );
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
              resolveConfig: ({ rawConfig }) => ({
                resolvedKey: asOptionalRecord(asOptionalRecord(rawConfig.providers)?.sample)
                  ?.apiKey,
              }),
              isConfigured: () => false,
              isConfiguredAsync: async ({ providerConfig }) =>
                providerConfig.resolvedKey === "synthetic-speech-key",
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
                    {
                      id: "openai",
                      contracts: {
                        mediaUnderstandingProviders: ["openai"],
                      },
                    },
                    { id: "sample", contracts: { speechProviders: ["sample"] } },
                  ],
                }),
              },
              async () => {
                const call = createTalkHandlerCaller({ ...talkHandlers, ...sessionReadHandlers });
                for (const [params, configured] of [
                  [{ sessionKey }, selectedHasCredentials],
                  [{}, !selectedHasCredentials],
                ] as const) {
                  const respond = vi.fn();
                  await call("talk.catalog", { params, client, context, respond });
                  expect(respond.mock.calls[0]?.[2]).toBeUndefined();
                  expect(expectRespondOk(respond)).toMatchObject({
                    speech: {
                      providers: [
                        expect.objectContaining({
                          id: "sample",
                          configured: !selectedHasCredentials,
                        }),
                      ],
                    },
                    transcription: {
                      ready: configured,
                      providers: [expect.objectContaining({ id: "openai", configured })],
                    },
                  });
                }
                for (const key of ["agent:researcher:hidden", "agent:researcher:missing"]) {
                  const catalog = vi.fn();
                  const resolved = vi.fn();
                  await call("talk.catalog", {
                    params: { sessionKey: key },
                    client,
                    context,
                    respond: catalog,
                  });
                  await call("sessions.resolve", {
                    params: { key },
                    client,
                    context,
                    respond: resolved,
                  });
                  expectRespondError(catalog, { message: `No session found: ${key}` });
                  expect(catalog.mock.calls[0]?.[2]).toEqual(resolved.mock.calls[0]?.[2]);
                }
              },
            );
          } finally {
            projection.dispose();
            profileCatalog.release();
          }
        },
      );
    },
  );
});
