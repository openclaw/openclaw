import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callAgentHandler } from "./agents-mutate.test-support.js";
import { agentsHandlers } from "./agents.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const roster = vi.hoisted(() => ({
  defaultId: "ops",
  ownership: "explicit" as const,
  selectionRequired: true,
  mainKey: "main",
  scope: "per-sender" as const,
  agents: [
    { id: "ops", name: "Operations" },
    { id: "research", name: "Research" },
  ],
}));

// Roster enrichment reads workspaces and model state; authorization remains real.
vi.mock("../session-utils.js", () => ({
  listAgentsForGateway: async () => roster,
}));

function roleConfig(agents: GatewayOperatorRoleDefinition["agents"]): OpenClawConfig {
  return {
    agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    gateway: {
      roles: {
        definitions: {
          reader: { sessions: { others: "none" }, agents, scopes: ["operator.read"] },
        },
      },
    },
  };
}

function readerClient(system = false): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", version: "test", platform: "test", mode: "test" },
      role: "operator",
      scopes: ["operator.read"],
    },
    authenticatedUserProfile: {
      profileId: "reader-profile",
      displayName: "Reader",
      hasAvatar: false,
      updatedAt: 1,
    },
    preparedSessionProfile: {
      profileId: "reader-profile",
      aliases: new Set(["reader-profile"]),
      role: "reader",
    },
    ...(system ? { internal: { operatorRoleActor: { kind: "system" as const } } } : {}),
  };
}

async function listAgents(
  cfg: () => OpenClawConfig,
  expected: string[],
  client = readerClient(),
  catalog: GatewayRequestContext["readPreparedGatewayModelCatalog"] = async () => ({ entries: [] }),
  batchCatalog?: GatewayRequestContext["readPreparedGatewayModelCatalogBatch"],
) {
  const respond = await callAgentHandler(
    expectDefined(agentsHandlers["agents.list"], "agents.list handler"),
    "agents.list",
    {},
    {
      client,
      context: {
        getRuntimeConfig: cfg,
        readPreparedGatewayModelCatalog: catalog,
        readPreparedGatewayModelCatalogBatch: batchCatalog,
      } as GatewayRequestContext,
    },
  );
  // Routing metadata describes Gateway ownership, independently of the reader's roster.
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    true,
    { ...roster, agents: roster.agents.filter((agent) => expected.includes(agent.id)) },
    undefined,
  );
}

test.each([
  { agents: ["research"], system: false, expected: ["research"] },
  { agents: [], system: false, expected: [] },
  { agents: "*" as const, system: false, expected: ["ops", "research"] },
  { agents: [], system: true, expected: ["ops", "research"] },
])(
  "agents.list scopes discovery for agents=$agents system=$system",
  async ({ agents, system, expected }) => {
    await listAgents(() => roleConfig(agents), expected, readerClient(system));
  },
);

test.each(["single", "batch"] as const)(
  "agents.list returns an empty roster without waiting for the %s catalog reader",
  async (mode) => {
    const entered = createDeferred();
    const released = createDeferred();
    const waitForCatalog = async () => {
      entered.resolve();
      await released.promise;
    };
    const response = listAgents(
      () => roleConfig([]),
      [],
      readerClient(),
      async () => {
        await waitForCatalog();
        return { entries: [] };
      },
      mode === "batch"
        ? async () => {
            await waitForCatalog();
            return [];
          }
        : undefined,
    );
    try {
      expect(
        await Promise.race([
          response.then(() => "responded"),
          entered.promise.then(() => "waiting for catalog"),
        ]),
      ).toBe("responded");
    } finally {
      released.resolve();
      await response;
    }
  },
);

test("agents.list applies role changes made while catalog preparation is pending", async () => {
  let cfg = roleConfig(["ops", "research"]);
  const started = createDeferred();
  const released = createDeferred();
  const response = listAgents(
    () => cfg,
    ["research"],
    readerClient(),
    async () => {
      started.resolve();
      await released.promise;
      return { entries: [] };
    },
  );
  await started.promise;
  cfg = roleConfig(["research"]);
  released.resolve();
  await response;
});
