import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { callAgentHandler } from "./agents-mutate.test-support.js";
import { agentsHandlers } from "./agents.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const roster = vi.hoisted(() => ({
  defaultId: "ops",
  agents: [{ id: "ops" }, { id: "research" }],
}));

// Roster enrichment reads workspaces and model state; authorization remains real.
vi.mock("../session-utils.js", () => ({
  listAgentsForGateway: async () => roster,
}));

function roleConfig(agents: GatewayOperatorRoleDefinition["agents"]): OpenClawConfig {
  const reader: GatewayOperatorRoleDefinition = {
    sessions: { others: "none" },
    agents,
    scopes: ["operator.read"],
  };
  return {
    agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    gateway: { roles: { definitions: { reader } } },
  };
}

function readerClient(system = false): GatewayClient {
  return {
    connect: gatewayConnect(["operator.read"], { id: "test", mode: "test" }),
    authenticatedUserProfile: gatewayProfile("reader-profile", "Reader"),
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
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    true,
    { ...roster, agents: roster.agents.filter((agent) => expected.includes(agent.id)) },
    undefined,
  );
}

test.each([
  { agents: ["research"], system: false, expected: ["research"] },
  { agents: "*" as const, system: false, expected: ["ops", "research"] },
  { agents: [], system: true, expected: ["ops", "research"] },
])(
  "agents.list scopes discovery for agents=$agents system=$system",
  async ({ agents, system, expected }) => {
    await listAgents(() => roleConfig(agents), expected, readerClient(system));
  },
);

test("agents.list bypasses catalog readers for an empty roster", async () => {
  const catalog = vi.fn(async () => ({ entries: [] }));
  const batch = vi.fn(async () => []);
  await listAgents(() => roleConfig([]), [], readerClient(), catalog, batch);
  expect(catalog).not.toHaveBeenCalled();
  expect(batch).not.toHaveBeenCalled();
});

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
