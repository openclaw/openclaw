// Session MCP tool tests cover the opaque, sanitized Gateway projection.
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenClawSessionTools } from "./session-tools.js";
import { registerSessionMcpTools } from "./session-tools-registration.js";

const openServers: Array<{ client: Client; server: McpServer }> = [];

export async function connectSessionTools(params: {
  request: (method: string, payload: Record<string, unknown>) => Promise<unknown>;
  methods: string[];
  scopes?: string[];
}) {
  const service = new OpenClawSessionTools({
    request: params.request,
    access: () => ({
      methods: new Set(params.methods),
      scopes: new Set(params.scopes ?? ["operator.read", "operator.write"]),
    }),
  });
  const server = new McpServer({ name: "openclaw-test", version: "1.0.0" });
  registerSessionMcpTools(server, service);
  const client = new Client({ name: "session-tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openServers.push({ client, server });
  return { client };
}

export async function closeSessionTools() {
  await Promise.all(
    openServers.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }),
  );
}

export function predictableSessionId(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("base64url");
}

export function structuredContent(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}
