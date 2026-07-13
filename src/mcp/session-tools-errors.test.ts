import { GatewayClientRequestError } from "@openclaw/gateway-client";
import { ErrorCodes } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  closeSessionTools,
  connectSessionTools,
  structuredContent,
} from "./session-tools.test-support.js";

afterEach(closeSessionTools);

describe("OpenClaw session MCP tools", () => {
  test("fails closed when hello does not grant or advertise a capability", async () => {
    const request = vi.fn();
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.list"],
      scopes: [],
    });

    const result = await client.callTool({
      name: "openclaw_sessions_list",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(structuredContent(result)).toEqual({ error: { code: "unsupported" } });
    expect(request).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "an invalid Gateway response",
      request: async () => ({ unexpected: true }),
      code: "invalid_response",
    },
    {
      name: "a Gateway request failure",
      request: async () => {
        throw new Error("private gateway failure detail");
      },
      code: "gateway_unavailable",
    },
  ])("returns a fixed safe code for $name", async ({ request, code }) => {
    const mcp = await connectSessionTools({
      request,
      methods: ["sessions.list"],
      scopes: ["operator.read"],
    });

    const result = await mcp.client.callTool({
      name: "openclaw_sessions_list",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(structuredContent(result)).toEqual({ error: { code } });
    expect(JSON.stringify(result)).not.toContain("private gateway failure detail");
  });

  test.each([
    ErrorCodes.NOT_LINKED,
    ErrorCodes.NOT_PAIRED,
    ErrorCodes.AGENT_TIMEOUT,
    ErrorCodes.INVALID_REQUEST,
    ErrorCodes.APPROVAL_NOT_FOUND,
  ])("maps Gateway rejection %s without leaking its payload", async (gatewayCode) => {
    const request = async () => {
      throw new GatewayClientRequestError({
        code: gatewayCode,
        message: "private Gateway rejection detail",
        details: { sessionKey: "agent:main:dashboard:private" },
      });
    };
    const mcp = await connectSessionTools({
      request,
      methods: ["sessions.list"],
      scopes: ["operator.read"],
    });

    const result = await mcp.client.callTool({
      name: "openclaw_sessions_list",
      arguments: { archived: false },
    });

    expect(result.isError).toBe(true);
    expect(structuredContent(result)).toEqual({ error: { code: "rejected" } });
    expect(JSON.stringify(result)).not.toContain("private Gateway rejection detail");
    expect(JSON.stringify(result)).not.toContain("agent:main:dashboard:private");
  });

  test("keeps Gateway unavailability distinct from request rejection", async () => {
    const request = async () => {
      throw new GatewayClientRequestError({
        code: ErrorCodes.UNAVAILABLE,
        message: "private Gateway outage detail",
        details: { endpoint: "wss://private.example" },
      });
    };
    const mcp = await connectSessionTools({
      request,
      methods: ["sessions.list"],
      scopes: ["operator.read"],
    });

    const result = await mcp.client.callTool({
      name: "openclaw_sessions_list",
      arguments: { archived: false },
    });

    expect(result.isError).toBe(true);
    expect(structuredContent(result)).toEqual({ error: { code: "gateway_unavailable" } });
    expect(JSON.stringify(result)).not.toContain("private Gateway outage detail");
    expect(JSON.stringify(result)).not.toContain("wss://private.example");
  });

  test("rejects malformed opaque ids and unknown arguments before Gateway access", async () => {
    const request = vi.fn();
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.list", "chat.history"],
      scopes: ["operator.read"],
    });

    const malformedId = await client.callTool({
      name: "openclaw_session_detail",
      arguments: { session_id: "!".repeat(43) },
    });
    const unknownArgument = await client.callTool({
      name: "openclaw_sessions_list",
      arguments: { surprise: true },
    });

    expect(malformedId.isError).toBe(true);
    expect(unknownArgument.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
