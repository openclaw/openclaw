import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { mcpEventsHandlers } from "./mcp-events.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  request: vi.fn<typeof import("../../agents/mcp-event-request.js").requestMcpEvent>(),
  prepare: vi.fn<typeof import("../../plugins/service-mcp-events.js").prepareMcpEventConnection>(),
  release: vi.fn(),
}));
vi.mock("../../agents/mcp-event-request.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/mcp-event-request.js")>()),
  requestMcpEvent: mocks.request,
  MCP_EVENTS_PROTOCOL_VERSION: "2026-07-28",
}));
vi.mock("../../plugins/service-mcp-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/service-mcp-events.js")>()),
  prepareMcpEventConnection: mocks.prepare,
}));
vi.mock("./cron-caller-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cron-caller-scope.js")>()),
  readCronCallerScope: () => undefined,
}));
vi.mock("./agent-runtime-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runtime-authority.js")>()),
  assertActiveAgentRuntimeAuthority: () => {},
}));
vi.mock("./agent-id-shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-id-shared.js")>()),
  resolveAgentIdOrRespondError: ({ cfg }: { cfg: unknown }) => ({ cfg, agentId: "main" }),
}));

const event = {
  name: "calendar.changed",
  description: "A calendar changed",
  delivery: ["webhook"],
  inputSchema: { type: "object" },
  payloadSchema: { type: "object" },
};
function fixture() {
  const respond = vi.fn();
  const client: GatewayClient = {
    connId: "catalog-client",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      scopes: ["operator.read"],
    },
    authenticatedUserId: "alice@example.test",
  };
  let current = true;
  const cfg = {};
  const registry = createGatewayMethodRegistry([
    {
      name: "mcp-events.status",
      owner: { kind: "plugin", pluginId: "mcp-events" },
      scope: "operator.admin",
      handler: () => {},
    },
  ]);
  const runtime = makeContextParams({ getAttachedGatewayMethodRegistry: () => registry });
  onTestFinished(() => runtime.runtime.scheduler.stop());
  const context = createGatewayRequestContext(runtime);
  context.getRuntimeConfig = () => cfg;
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: "catalog", method: "mcp.events.list" },
    isWebchatConnect: () => false,
    params: { serverName: "calendar" },
    client,
    context,
    respond,
    hasCurrentClientAuthority: () => current,
  };
  return {
    options,
    respond,
    client,
    registry,
    revoke: () => {
      current = false;
    },
    run: () => mcpEventsHandlers["mcp.events.list"]!(options),
  };
}
beforeEach(() => {
  mocks.request.mockReset();
  mocks.prepare.mockReset();
  mocks.release.mockReset();
  mocks.prepare.mockImplementation(async (input) => {
    input.assertCurrent();
    return {
      endpoint: "https://calendar.example/mcp",
      server: {},
      cfg: input.cfg,
      agentDir: "/agent",
      configurationIdentity: "fixture-config",
      authorizationIdentity: "fixture-authorization",
      selector: {
        serverName: input.serverName,
        server: {},
        cfg: input.cfg,
        agentDir: "/agent",
        requesterScope: input.principal.requester,
        requesterResolver: false,
      },
      revalidate: async () => input.assertCurrent(),
      requesterScope: input.principal.requester,
      assertCurrent: input.assertCurrent,
      release: mocks.release,
    };
  });
  mocks.request.mockImplementation(async (input) => {
    input.assertCurrent();
    return input.method === "server/discover"
      ? { supportedVersions: ["2026-07-28"], capabilities: { events: {} } }
      : {
          events: [{ ...event, privateServerField: "not-public" }],
          nextCursor: "page-two",
          remoteAccount: "not-public",
        };
  });
});
describe("mcp.events.list caller boundary", () => {
  it("discovers before listing and returns one explicit page without server-private fields", async () => {
    const f = fixture();
    f.options.params.cursor = "page-one";
    await f.run();
    expect(mocks.request.mock.calls.map(([input]) => input.method)).toEqual([
      "server/discover",
      "events/list",
    ]);
    expect(mocks.request.mock.lastCall?.[0].params).toEqual({ cursor: "page-one" });
    expect(f.respond).toHaveBeenCalledWith(
      true,
      { serverName: "calendar", events: [event], nextCursor: "page-two" },
      undefined,
    );
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.prepare.mock.calls[0]?.[0].principal.requester).toBeUndefined();
  });
  it("refuses wire-supplied requester identities and connection URLs", async () => {
    const f = fixture();
    f.options.params.requesterSenderId = "another-user";
    f.options.params.url = "https://other.example/mcp";
    await f.run();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(f.respond.mock.calls[0]?.[0]).toBe(false);
  });
  it("does not connect when the optional plugin is absent", async () => {
    const f = fixture();
    f.options.context.getGatewayMethodRegistry = () => createGatewayMethodRegistry([]);
    await f.run();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(f.respond.mock.calls[0]?.[0]).toBe(false);
  });
  it("rechecks live caller authority after discovery before listing", async () => {
    const f = fixture();
    mocks.request.mockImplementationOnce(async () => {
      f.revoke();
      return { supportedVersions: ["2026-07-28"], capabilities: { events: {} } };
    });
    await f.run();
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(f.respond.mock.calls[0]?.[0]).toBe(false);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("does not disclose a catalog if the caller loses read scope during the response", async () => {
    const f = fixture();
    mocks.request.mockImplementation(async (input) => {
      if (input.method === "server/discover") {
        return { supportedVersions: ["2026-07-28"], capabilities: { events: {} } };
      }
      f.client.connect.scopes = [];
      return { events: [event] };
    });
    await f.run();
    expect(f.respond.mock.calls[0]?.[0]).toBe(false);
  });
  it("rejects remote oversized pages rather than silently truncating", async () => {
    const f = fixture();
    mocks.request.mockImplementation(async (input) =>
      input.method === "server/discover"
        ? { supportedVersions: ["2026-07-28"], capabilities: { events: {} } }
        : { events: Array.from({ length: 1001 }, () => event) },
    );
    await f.run();
    expect(f.respond.mock.calls[0]?.[0]).toBe(false);
  });
});
