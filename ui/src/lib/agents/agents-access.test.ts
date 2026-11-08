import { expect, it, vi } from "vitest";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createAgentIdentityCapability } from "./identity.ts";
import { createAgentCapability } from "./index.ts";

it.each(["operator.sessions.read", "operator.sessions.write"])(
  "keeps session discovery under %s while retiring broader file access",
  async (scope) => {
    const roster = { defaultId: "main", agents: [{ id: "main" }] };
    const identity = { agentId: "main", name: "Main", avatar: "" };
    const files = { agentId: "main", workspace: "/workspace", files: [] };
    const request = vi.fn(async (method: string) => {
      if (method === "agents.list") {
        return roster;
      }
      if (method === "agent.identity.get") {
        return identity;
      }
      if (method === "agents.files.list") {
        return files;
      }
      throw new Error("Unexpected method: " + method);
    });
    const source = createApplicationGateway();
    const hello = gatewayHelloForMethods(
      ["agents.list", "agent.identity.get", "agents.files.list"],
      ["operator.read"],
    );
    source.publish({
      ...source.gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected",
      hello,
    });
    const agents = createAgentCapability(source.gateway);
    const identities = createAgentIdentityCapability(source.gateway);
    try {
      await Promise.all([
        agents.ensureList(),
        agents.ensureFiles("main"),
        identities.ensure(["main"]),
      ]);
      expect(agents.files("main").list).toEqual(files);

      const restrictedHello = { ...hello, auth: { ...hello.auth!, scopes: [scope] } };
      source.publish({ ...source.gateway.snapshot, hello: restrictedHello });
      expect(agents.state.agentsList).toEqual(roster);
      expect(identities.get("main")).toEqual(identity);
      expect(agents.files("main").list).toBeNull();

      source.publish({ ...source.gateway.snapshot, phase: "reconnecting", hello: null });
      expect(agents.state.agentsList).toEqual(roster);
      expect(identities.get("main")).toEqual(identity);
      source.publish({ ...source.gateway.snapshot, phase: "connected", hello: restrictedHello });
      await Promise.all([agents.ensureList(), identities.ensure(["main"])]);
      expect(agents.state.agentsList).toEqual(roster);
      expect(identities.get("main")).toEqual(identity);
      expect(request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(2);
      expect(request.mock.calls.filter(([method]) => method === "agent.identity.get")).toHaveLength(
        2,
      );

      source.publish({
        ...source.gateway.snapshot,
        hello: { ...hello, auth: { ...hello.auth!, scopes: [] } },
      });
      expect(agents.state.agentsList).toBeNull();
      expect(identities.get("main")).toBeNull();
    } finally {
      agents.dispose();
    }
  },
);
