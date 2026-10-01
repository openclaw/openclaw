import { expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { agentListHandler } from "./agents-list.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

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
  client = readerClient(),
  catalog: GatewayRequestContext["readPreparedGatewayModelCatalog"] = async () => ({ entries: [] }),
) {
  const respond = vi.fn<RespondFn>();
  await agentListHandler({
    req: { type: "req", id: "agent-list-test", method: "agents.list", params: {} },
    params: {},
    client,
    context: {
      getRuntimeConfig: cfg,
      readPreparedGatewayModelCatalog: catalog,
    } as GatewayRequestContext,
    respond,
    isWebchatConnect: () => false,
  });
  return respond;
}

test.each([
  { agents: ["research"], system: false, expected: ["research"] },
  { agents: [], system: false, expected: [] },
  { agents: "*" as const, system: false, expected: ["ops", "research"] },
  { agents: [], system: true, expected: ["ops", "research"] },
])(
  "agents.list scopes discovery for agents=$agents system=$system",
  async ({ agents, system, expected }) => {
    const respond = await listAgents(() => roleConfig(agents), readerClient(system));
    // Routing metadata describes Gateway ownership, independently of the reader's roster.
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      true,
      { ...roster, agents: roster.agents.filter((agent) => expected.includes(agent.id)) },
      undefined,
    );
  },
);

test("agents.list applies role changes made while catalog preparation is pending", async () => {
  let cfg = roleConfig(["ops", "research"]);
  const started = createDeferred();
  const released = createDeferred();
  const response = listAgents(
    () => cfg,
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
  expect(await response).toHaveBeenCalledExactlyOnceWith(
    true,
    { ...roster, agents: [roster.agents[1]] },
    undefined,
  );
});
