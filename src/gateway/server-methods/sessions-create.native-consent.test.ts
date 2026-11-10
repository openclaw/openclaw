import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  registerNative,
  useNativeProcessFixture,
} from "../../agents/harness/acp-native-process.test-support.js";
import { configFor, modelDefinition } from "../../agents/model-auth.fixtures.test-support.js";
import type * as ModelRuntimeChoice from "../../agents/model-runtime-choice.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { startSessionMutationRequest } from "./sessions-mutations.native-consent.test-support.js";
import type { GatewayClient } from "./types.js";

vi.mock("../../agents/model-runtime-choice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ModelRuntimeChoice>()),
  // Catalog publication can precede loading the native harness implementation.
  preparePublishedModelRuntimeChoice: async () => ({
    kind: "ready",
    runtimeId: "acp-opencode",
    validate: () => undefined,
  }),
}));

useNativeProcessFixture();

it.each([
  { admin: false, profiled: true },
  { admin: true, profiled: true },
  { admin: true, profiled: false },
])(
  "only promotes an admin's remembered native runtime at creation (admin=$admin, profiled=$profiled)",
  ({ admin, profiled }) =>
    withOpenClawTestState({ label: "create-native-consent" }, async (state) => {
      const config: OpenClawConfig = {
        tools: { profile: "full", deny: ["browser"] },
        ...configFor("acp-opencode", "https://native.invalid", {
          api: "openai-completions",
          models: [modelDefinition("selected", { reasoning: false })],
        }),
        agents: {
          defaults: { workspace: state.workspaceDir, model: "acp-opencode/selected" },
          entries: {
            main: {
              nativeRuntimeConsent: ["acp-opencode"],
              models: { "acp-opencode/selected": { agentRuntime: { id: "acp-opencode" } } },
            },
          },
        },
      };
      await state.writeConfig(config);
      const native = await registerNative(state, config, "owner-agent.mjs");
      const profile = ensureProfileForEmail("native-creation@example.test");
      const scopes = admin ? ["operator.admin"] : ["operator.write"];
      const client: GatewayClient = {
        ...sharingPolicyClient({ scopes, user: profiled ? profile.id : undefined }),
        connId: "native-creation",
      };
      delete client.authenticatedUserId;
      if (profiled) {
        client.internal = {
          operatorRunAuthority: createAdmittedRunOperatorAuthority({
            profileId: profile.id,
            scopes,
            assertCurrent() {},
          }),
        };
      }
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      context.readPreparedGatewayModelCatalog = () => context.loadGatewayModelCatalogSnapshot();
      const key = `agent:main:dashboard:native-create-${admin}`;
      try {
        const respond = await withPluginRuntimeGenerationScope(
          {
            // Runtime registration and selection use the same prepared plugin inventory.
            metadataSnapshot: createPluginMetadataSnapshotFixture({
              plugins: [
                {
                  id: "acpx",
                  activation: { onAgentHarnesses: ["acp-opencode"] },
                },
              ],
            }),
            pluginRegistry: requireActivePluginRegistry(),
          },
          async () => {
            const request = startSessionMutationRequest(
              "sessions.create",
              {
                key,
                agentId: "main",
                model: "acp-opencode/selected",
                agentRuntime: "acp-opencode",
              },
              { client, context },
            );
            await request.running;
            return request.respond;
          },
        );
        expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0]?.[2])).toBe(true);
        const entry = loadSessionEntry({ agentId: "main", sessionKey: key });
        expect([entry?.nativeRuntimeConsent, entry?.permissionMode, entry?.sandboxMode]).toEqual(
          admin ? [undefined, "full", "off"] : [undefined, undefined, undefined],
        );
      } finally {
        await native.service.stop?.(native.context);
      }
    }),
);
