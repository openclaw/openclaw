import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { ProviderThinkingProfile } from "../../plugins/provider-thinking.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { PreparedGatewayModelCatalog } from "../server-model-catalog.types.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import {
  identifiedClient,
  requestContext,
  seedSessions,
} from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

async function describeSession(
  context: GatewayRequestContext,
  key: string,
  client: GatewayClient = identifiedClient("owner@example.com"),
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionByKeyReadHandlers["sessions.describe"]!({
    req: { type: "req", id: "describe-catalog", method: "sessions.describe", params: { key } },
    params: { key },
    client,
    context,
    isWebchatConnect: () => false,
    respond: (...response) => responses.push(response),
  });
  expect(responses).toHaveLength(1);
  return responses[0];
}

function preparedCatalog(
  profile: ProviderThinkingProfile,
  thinkingLevelMap?: ModelCatalogEntry["thinkingLevelMap"],
): PreparedGatewayModelCatalog {
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.providers.push({
    pluginId: "catalog-fixture",
    source: "test",
    provider: {
      id: "catalog-fixture",
      label: "Catalog fixture",
      auth: [],
      resolveThinkingProfile: () => profile,
    },
  });
  const entries: ModelCatalogEntry[] = [
    {
      id: "reasoner",
      provider: "catalog-fixture",
      name: "Reasoner",
      reasoning: true,
      thinkingLevelMap,
    },
  ];
  return { entries, pluginRegistry };
}

describe("sessions.describe catalog projection", () => {
  it.each([
    { agentId: "main", levels: [], defaultLevel: undefined },
    { agentId: "work", levels: [{ id: "high", label: "Deep effort" }], defaultLevel: "high" },
  ])(
    "uses $agentId's completed entries and provider policy",
    async ({ agentId, levels, defaultLevel }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const config = await seedSessions();
        config.agents = { ...config.agents, defaults: { model: "catalog-fixture/reasoner" } };
        const catalogs = new Map([
          [
            "main",
            preparedCatalog(
              { levels: [] },
              {
                off: null,
                minimal: null,
                low: null,
                medium: null,
                high: null,
                xhigh: null,
                max: null,
              },
            ),
          ],
          [
            "work",
            preparedCatalog({
              levels: [{ id: "high", label: "Deep effort" }],
              defaultLevel: "high",
            }),
          ],
        ]);
        const context = {
          ...requestContext(config),
          readPreparedGatewayModelCatalog: async (options?: { agentId?: string }) =>
            options?.agentId ? catalogs.get(options.agentId) : undefined,
        };

        const response = await describeSession(context, `agent:${agentId}:active`);

        expect(response?.[0]).toBe(true);
        expect(response?.[1]).toMatchObject({
          session: { agentId, thinkingLevels: levels, thinkingDefault: defaultLevel },
        });
      });
    },
  );

  it("reads the current session after the catalog lookup yields", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const key = "agent:main:active";
      const context = {
        ...requestContext(config),
        readPreparedGatewayModelCatalog: async () => {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: key },
            { sessionId: "replacement-session", label: "Current conversation" },
          );
          return undefined;
        },
      };

      const response = await describeSession(context, key);

      expect(response?.[1]).toMatchObject({
        session: { sessionId: "replacement-session", displayName: "Current conversation" },
      });
    });
  });

  it("does not expose a session made a draft during the catalog lookup", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      config.gateway = {
        roles: {
          default: "reader",
          definitions: {
            reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
          },
        },
      };
      const key = "agent:main:active";
      const ownerId = ensureProfileForEmail("owner@example.com").id;
      const viewerId = ensureProfileForEmail("viewer@example.com").id;
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        { createdActor: { type: "human", source: "profile", id: ownerId } },
      );
      const context = {
        ...requestContext(config),
        readPreparedGatewayModelCatalog: async () => {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: key },
            { visibility: "draft" },
          );
          return undefined;
        },
      };

      const response = await describeSession(context, key, identifiedClient(viewerId));

      expect(response?.[0]).toBe(true);
      expect(response?.[1]).toEqual({ session: null });
    });
  });

  it("keeps the primary read available when catalog decoration fails", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const context = {
        ...requestContext(config),
        readPreparedGatewayModelCatalog: async () => {
          throw new Error("prepared owner retired");
        },
      };

      const response = await describeSession(context, "agent:main:active");

      expect(response?.[0]).toBe(true);
      expect(response?.[1]).toMatchObject({ session: { sessionId: "main-active" } });
    });
  });
});
