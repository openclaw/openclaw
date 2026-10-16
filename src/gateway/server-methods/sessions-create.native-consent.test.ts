import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  registerNative,
  useNativeProcessFixture,
} from "../../agents/harness/acp-native-process.test-support.js";
import type * as ModelRuntimeChoice from "../../agents/model-runtime-choice.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { GatewayClient, RespondFn } from "./types.js";

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
  async ({ admin, profiled }) => {
    await withOpenClawTestState({ label: "create-native-consent" }, async (state) => {
      const config: OpenClawConfig = {
        tools: { profile: "full", deny: ["browser"] },
        models: {
          providers: {
            "acp-opencode": {
              api: "openai-completions",
              baseUrl: "https://native.invalid",
              models: [
                {
                  id: "selected",
                  name: "Selected",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
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
        connId: "native-creation",
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          role: "operator",
          scopes,
          client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
        },
        ...(profiled
          ? {
              authenticatedUserProfile: {
                profileId: profile.id,
                displayName: null,
                hasAvatar: false,
                updatedAt: 1,
              },
              internal: {
                operatorRunAuthority: createAdmittedRunOperatorAuthority({
                  profileId: profile.id,
                  scopes,
                  assertCurrent() {},
                }),
              },
            }
          : {}),
      };
      const context = createDirectChatContext({ getRuntimeConfig: () => config });
      context.readPreparedGatewayModelCatalog = async () => {
        const catalog = await context.loadGatewayModelCatalogSnapshot();
        return { entries: catalog.entries, routeVariants: catalog.routeVariants };
      };
      const key = `agent:main:dashboard:native-create-${admin}`;
      const respond = vi.fn<RespondFn>();
      try {
        await expectDefined(
          coreGatewayHandlers["sessions.create"],
          "sessions.create",
        )({
          req: { type: "req", id: "native-create", method: "sessions.create" },
          params: {
            key,
            agentId: "main",
            model: "acp-opencode/selected",
            agentRuntime: "acp-opencode",
          },
          client,
          context,
          respond,
          isWebchatConnect: () => true,
        });
        expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls[0]?.[2])).toBe(true);
        const entry = loadSessionEntry({ agentId: "main", sessionKey: key });
        expect(entry?.nativeRuntimeConsent).toBeUndefined();
        if (admin) {
          expect(entry).toMatchObject({ permissionMode: "full", sandboxMode: "off" });
        } else {
          expect(entry?.permissionMode).toBeUndefined();
          expect(entry?.sandboxMode).toBeUndefined();
        }
      } finally {
        await native.service.stop?.(native.context);
      }
    });
  },
);
