import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Server } from "@modelcontextprotocol/server";
import { Type } from "typebox";
import type { AnyAgentTool } from "../agents/tools/common.js";

export function createTool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return { name, label: name, description: name, parameters: Type.Object({}), execute };
}

export const toolResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
});
export const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
export const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

export async function waitForStart(started: Promise<unknown>, call: Promise<unknown>) {
  await Promise.race([
    started,
    call.then(() => {
      throw new Error("Tool settled before the fixture gate");
    }),
  ]);
}

export function createMcpConnection(server: Server) {
  const client = new Client({ name: "mcp-test-client", version: "0.0.0" }, { capabilities: {} });
  const [outbound, inbound] = InMemoryTransport.createLinkedPair();
  return {
    client,
    outbound,
    inbound,
    connect: () => Promise.all([server.connect(inbound), client.connect(outbound)]),
    close: async () => {
      await server.close();
      await client.close();
    },
  };
}

export async function withMcpConnection<T>(server: Server, run: (client: Client) => Promise<T>) {
  const connection = createMcpConnection(server);
  try {
    await connection.connect();
    return await run(connection.client);
  } finally {
    await connection.close();
  }
}
