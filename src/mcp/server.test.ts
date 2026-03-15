import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RADAR_DEFENDER_CONFIG } from "../context/radar-defaults.js";
import { createRadarDefenderMcpServer } from "./server.js";

describe("createRadarDefenderMcpServer", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  });

  it("exposes the seven Radar MCP tools by default", async () => {
    const server = createRadarDefenderMcpServer(DEFAULT_RADAR_DEFENDER_CONFIG);
    const client = new Client({ name: "radar-defender-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    disposers.push(() => Promise.all([server.close(), client.close()]).then(() => undefined));

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).toSorted()).toEqual(
      [...DEFAULT_RADAR_DEFENDER_CONFIG.review.enabledTools].toSorted(),
    );
  });

  it("returns structured content for route and sql analysis", async () => {
    const server = createRadarDefenderMcpServer(DEFAULT_RADAR_DEFENDER_CONFIG);
    const client = new Client({ name: "radar-defender-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    disposers.push(() => Promise.all([server.close(), client.close()]).then(() => undefined));

    const routeResult = await client.callTool({
      name: "analyze_route",
      arguments: {
        method: "POST",
        route_path: "/api/admin/jobs/[id]",
        handler_source:
          "export async function POST(request) { const body = await request.json(); return Response.json(body); }",
      },
    });
    expect(routeResult.structuredContent).toMatchObject({
      tool: "analyze_route",
      summary: expect.objectContaining({
        finding_count: expect.any(Number),
      }),
    });

    const sqlResult = await client.callTool({
      name: "analyze_sql_policy",
      arguments: {
        table: "jobs",
        policy_name: "jobs_owner_policy",
        sql: "create policy jobs_owner_policy on jobs using (true) with check (true);",
      },
    });
    expect(sqlResult.structuredContent).toMatchObject({
      tool: "analyze_sql_policy",
      findings: expect.any(Array),
    });
  });
});
