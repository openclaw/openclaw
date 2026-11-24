// @vitest-environment node
import { expect, it } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { sessionReadHandlers } from "./sessions-read.js";
import { callGatewayHandler } from "./skills.test-helpers.js";
import { ttsHandlers } from "./tts.js";

const sessionKey = "agent:reader:listen";

it("tts.speak reads a session's reply in the voice of the agent that owns it", async () => {
  await withOpenClawTestState(
    { label: "tts-speak-session", prepareProfileCatalog: true },
    async (state) => {
      const config: OpenClawConfig = {
        // The write role may start sessions only for main, so reader's main stays unstartable to it.
        ...rolePolicyConfig(["main"]),
        agents: {
          ownership: "explicit",
          entries: {
            main: {},
            reader: {
              workspace: state.workspaceDir,
              tts: { maxTextLength: 8, providers: { sample: { voice: "reader-voice" } } },
            },
          },
        },
        tts: { provider: "sample", providers: { sample: { voice: "shared-voice" } } },
      };
      await state.writeConfig(config);
      const client = roleClient("view", "listener");
      const owner = roleClient("write", "session-owner");
      const ownerId = owner.authenticatedUserProfile!.profileId;
      for (const [key, visibility] of [
        [sessionKey, "shared"],
        ["agent:reader:hidden", "draft"],
      ] as const) {
        replaceSessionEntrySync(
          { agentId: "reader", sessionKey: key },
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
      const registry = createEmptyPluginRegistry();
      let clips = 0;
      registry.speechProviders.push({
        pluginId: "sample",
        source: "test",
        provider: {
          id: "sample",
          label: "Sample speech",
          isConfigured: () => true,
          // The clip is the voice it was asked for, so the RPC result names the layer that won.
          synthesize: async ({ providerConfig }) => {
            clips += 1;
            return {
              audioBuffer: Buffer.from(String(providerConfig.voice)),
              outputFormat: "mp3",
              fileExtension: ".mp3",
              voiceCompatible: false,
            };
          },
        },
      });
      try {
        await withPluginRuntimeGenerationScope(
          {
            pluginRegistry: registry,
            metadataSnapshot: createPluginMetadataSnapshotFixture({
              plugins: [{ id: "sample", contracts: { speechProviders: ["sample"] } }],
            }),
          },
          async () => {
            const call = (method: string, params: Record<string, unknown>, caller = client) =>
              callGatewayHandler({ ...ttsHandlers, ...sessionReadHandlers }, method, params, {
                client: caller,
                context,
              });
            for (const [params, voice] of [
              [{ text: "Hello." }, "shared-voice"],
              [{ text: "Hello.", sessionKey }, "reader-voice"],
            ] as const) {
              expect(await call("tts.speak", params)).toMatchObject({
                ok: true,
                error: undefined,
                response: {
                  audioBase64: Buffer.from(voice).toString("base64"),
                  provider: "sample",
                },
              });
            }
            // The agent's own text limit is a request error, as the shared one is.
            expect(await call("tts.speak", { text: "Hello there.", sessionKey })).toMatchObject({
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message: "tts.speak text too long (12 chars, max 8)",
              },
            });
            expect(clips).toBe(2);
            // A session the caller cannot read is as unknown as one that does not exist.
            for (const key of ["agent:reader:hidden", "agent:reader:missing"]) {
              const spoken = await call("tts.speak", { text: "Hello.", sessionKey: key });
              const resolved = await call("sessions.resolve", { key, allowMissing: false });
              expect(spoken).toMatchObject({
                ok: false,
                response: undefined,
                error: { code: "INVALID_REQUEST", message: `No session found: ${key}` },
              });
              expect(spoken.error).toEqual(resolved.error);
            }
            expect(clips).toBe(2);
            // Before its first turn, main reads in its agent's voice only for a caller who may start it.
            const main = { text: "Hello.", sessionKey: "agent:reader:main" };
            expect(await call("tts.speak", main)).toMatchObject({
              ok: true,
              response: { audioBase64: Buffer.from("reader-voice").toString("base64") },
            });
            const refused = await call("tts.speak", main, owner);
            expect(refused.error).toEqual(
              (await call("sessions.resolve", { key: main.sessionKey, allowMissing: false }, owner))
                .error,
            );
            expect(refused).toMatchObject({
              ok: false,
              error: { code: "INVALID_REQUEST", message: "No session found: agent:reader:main" },
            });
            expect(clips).toBe(3);
          },
        );
      } finally {
        projection.dispose();
      }
    },
  );
});
