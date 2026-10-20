import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { ProviderThinkingProfile } from "../../plugins/provider-thinking.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { PreparedGatewayModelCatalog } from "../server-model-catalog.types.js";
import { sessionReader } from "./sessions-keyed-read.test-support.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
  seedSessions,
} from "./sessions-read-cache.test-support.js";

const deep = {
  levels: [{ id: "high", label: "Deep effort" }],
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;
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
  return {
    entries: [
      {
        id: "reasoner",
        provider: "catalog-fixture",
        name: "Reasoner",
        reasoning: true,
        thinkingLevelMap,
      },
    ],
    pluginRegistry,
  };
}

it.each(["main", "work"])("uses %s's completed entries and provider policy", async (agentId) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const config = await seedSessions();
    config.agents = { ...config.agents, defaults: { model: "catalog-fixture/reasoner" } };
    const catalogs = new Map([
      [
        "main",
        preparedCatalog(
          { levels: [] },
          { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
        ),
      ],
      ["work", preparedCatalog(deep)],
    ]);
    const context = {
      ...requestContext(config),
      readPreparedGatewayModelCatalog: async (options?: { agentId?: string }) =>
        options?.agentId ? catalogs.get(options.agentId) : undefined,
    };
    const client = identifiedClient("owner@example.com");
    await initializeSessionReadContext(context);
    const result = await sessionReader(context, client, `agent:${agentId}:active`)();
    expect(result).toMatchObject({
      session: {
        agentId,
        thinkingLevels: [
          ...(agentId === "work" ? deep.levels : []),
          { id: "ultra", label: "ultra" },
        ],
      },
    });
    if (agentId === "work") {
      expect(result).toHaveProperty("session.thinkingDefault", "high");
    } else {
      expect(result).not.toHaveProperty("session.thinkingDefault");
    }
  });
});

it.each(["replacement", "draft", "failure"] as const)(
  "preserves current session visibility through catalog lookup: %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config = await seedSessions();
      const key = "agent:main:active";
      const scope = { agentId: "main", sessionKey: key };
      if (change === "draft") {
        config.gateway = {
          roles: {
            default: "reader",
            definitions: {
              reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
            },
          },
        };
        await upsertSessionEntryCore(scope, {
          createdActor: {
            type: "human",
            source: "profile",
            id: ensureProfileForEmail("owner@example.com").id,
          },
        });
      }
      const context = {
        ...requestContext(config),
        readPreparedGatewayModelCatalog: async () => {
          if (change === "failure") {
            throw new Error("prepared owner retired");
          }
          await upsertSessionEntryCore(
            scope,
            change === "draft"
              ? { visibility: "draft" }
              : { sessionId: "replacement-session", label: "Current conversation" },
          );
          return undefined;
        },
      };
      const client = identifiedClient(
        change === "draft" ? ensureProfileForEmail("viewer@example.com").id : "owner@example.com",
      );
      await initializeSessionReadContext(context);
      const result = await sessionReader(context, client, key)();
      if (change === "draft") {
        expect(result).toEqual({ session: null });
      } else {
        expect(result).toMatchObject({
          session:
            change === "replacement"
              ? { sessionId: "replacement-session", displayName: "Current conversation" }
              : { sessionId: "main-active" },
        });
      }
    });
  },
);
