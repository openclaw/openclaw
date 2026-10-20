import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastLogLine,
  mockError,
  mockLog,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";
import { runCliWithExitFinalization } from "./one-shot-exit.js";

const SESSION_ID = "cli-cleanup-fixture-session";
const PROTOCOL_VERSION = "2025-11-25";
const CLEANUP_ERROR = "MCP runtime cleanup could not confirm closure";
const CLEANUP_ERROR_WITH_RECOVERY =
  /MCP runtime cleanup could not confirm closure.*session termination support.*rerun/;
const CATALOG_ERROR = "fixture catalog unavailable";

describe("MCP CLI cleanup reporting", () => {
  let endpoint: string;
  let closeFixture: () => Promise<void>;
  let deleteStatus = 400;
  let failCatalog = false;
  const deleteHeaders: Array<{
    session: string | string[] | undefined;
    protocol: string | string[] | undefined;
  }> = [];

  beforeAll(async () => {
    const fixture = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          if (request.method === "DELETE") {
            deleteHeaders.push({
              session: request.headers["mcp-session-id"],
              protocol: request.headers["mcp-protocol-version"],
            });
            response.writeHead(deleteStatus).end();
            return;
          }
          if (request.method !== "POST") {
            response.writeHead(405).end();
            return;
          }
          void (async () => {
            let body = "";
            for await (const chunk of request) {
              body += String(chunk);
            }
            const message = JSON.parse(body) as { id?: string | number; method: string };
            if (message.method === "notifications/initialized") {
              response.writeHead(202).end();
              return;
            }
            response.setHeader("content-type", "application/json");
            if (message.method === "initialize") {
              response.setHeader("mcp-session-id", SESSION_ID);
              response.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: "cleanup-fixture", version: "1" },
                  },
                }),
              );
              return;
            }
            if (message.method === "tools/list") {
              response.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  ...(failCatalog
                    ? { error: { code: -32603, message: CATALOG_ERROR } }
                    : {
                        result: {
                          tools: [
                            {
                              name: "ping",
                              inputSchema: { type: "object" },
                              annotations: { readOnlyHint: true },
                            },
                          ],
                        },
                      }),
                }),
              );
              return;
            }
            response.writeHead(400).end();
          })().catch((error: unknown) =>
            response.destroy(error instanceof Error ? error : undefined),
          );
        }),
    });
    endpoint = `http://127.0.0.1:${fixture.claim.port}/mcp`;
    closeFixture = async () => {
      fixture.listener.closeAllConnections();
      await fixture.releaseListener();
      await fixture.claim.release();
    };
  });

  afterAll(async () => {
    await closeFixture?.();
  });

  beforeEach(() => {
    resetMcpCliTestState();
    deleteStatus = 400;
    failCatalog = false;
    deleteHeaders.length = 0;
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
  });

  async function withMcpConfig(
    servers: Record<string, unknown>,
    run: (configPath: string) => Promise<void>,
  ) {
    await withTempHome("openclaw-mcp-cleanup-", async (home) => {
      vi.spyOn(process, "cwd").mockReturnValue(await createWorkspace());
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.writeFile(configPath, `${JSON.stringify({ mcp: { servers } })}\n`);
      await run(configPath);
    });
  }

  function serverConfig() {
    return { url: endpoint, transport: "streamable-http" };
  }

  async function probe(args: string[]) {
    await runCliWithExitFinalization({
      run: () => runMcpCommand(["mcp", "probe", "docs", ...args]),
      onError: (error) => {
        throw error;
      },
    });
  }

  function errors() {
    return mockError.mock.calls.map(([line]) => String(line)).join("\n");
  }

  it.each([
    { status: 204, confirmed: true },
    { status: 404, confirmed: true },
    { status: 405, confirmed: true },
    { status: 400, confirmed: false },
    { status: 401, confirmed: false },
    { status: 500, confirmed: false },
  ])("reports catalog and cleanup status for DELETE $status", async ({ status, confirmed }) => {
    deleteStatus = status;
    await withMcpConfig({ docs: serverConfig() }, async () => {
      await probe(["--json"]);

      expect(mockLog).toHaveBeenCalledTimes(1);
      const result = JSON.parse(lastLogLine());
      expect(result).toMatchObject({
        servers: { docs: { tools: 1 } },
        tools: ["docs__ping"],
        diagnostics: [],
      });
      expect(deleteHeaders).toEqual([{ session: SESSION_ID, protocol: PROTOCOL_VERSION }]);
      if (confirmed) {
        expect(result).not.toHaveProperty("cleanupError");
        expect(mockError).not.toHaveBeenCalled();
        expect(process.exitCode).toBeUndefined();
      } else {
        expect(result.cleanupError).toMatch(CLEANUP_ERROR_WITH_RECOVERY);
        expect(errors()).toMatch(CLEANUP_ERROR_WITH_RECOVERY);
        expect(process.exitCode).toBe(1);
      }
    });
  });

  it("prints discovered tools but fails a text probe when cleanup is uncertain", async () => {
    await withMcpConfig({ docs: serverConfig() }, async () => {
      await probe([]);

      const output = mockLog.mock.calls.map(([line]) => String(line)).join("\n");
      expect(output).toContain("- docs: 1 tools");
      expect(output).toMatch(CLEANUP_ERROR_WITH_RECOVERY);
      expect(errors()).toMatch(CLEANUP_ERROR_WITH_RECOVERY);
      expect(process.exitCode).toBe(1);
    });
  });

  it("includes uncertain cleanup as an error in the Doctor JSON report", async () => {
    await withMcpConfig({ docs: serverConfig() }, async () => {
      await expect(
        runMcpCommand(["mcp", "doctor", "docs", "--probe", "--json"]),
      ).rejects.toMatchObject({ code: 1 });

      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: false,
        servers: [
          {
            name: "docs",
            ok: false,
            issues: expect.arrayContaining([
              { level: "error", message: expect.stringMatching(CLEANUP_ERROR_WITH_RECOVERY) },
            ]),
          },
        ],
      });
    });
  });

  it.each(["add", "configure"] as const)(
    "does not save %s configuration after failed verification cleanup",
    async (command) => {
      await withMcpConfig(command === "add" ? {} : { docs: serverConfig() }, async (configPath) => {
        const before = await fs.readFile(configPath, "utf8");
        const args =
          command === "add"
            ? ["mcp", "add", "docs", "--url", endpoint, "--transport", "streamable-http"]
            : ["mcp", "configure", "docs", "--include", "ping", "--probe"];

        await expect(runMcpCommand(args)).rejects.toMatchObject({ code: 1 });

        expect(errors()).toMatch(CLEANUP_ERROR_WITH_RECOVERY);
        expect(errors()).toContain("Configuration was not saved.");
        expect(await fs.readFile(configPath, "utf8")).toBe(before);
        expect(deleteHeaders).toEqual([{ session: SESSION_ID, protocol: PROTOCOL_VERSION }]);
      });
    },
  );

  it("preserves the discovery diagnostic when cleanup also fails", async () => {
    failCatalog = true;
    await withMcpConfig({ docs: serverConfig() }, async () => {
      await probe(["--json"]);

      expect(JSON.parse(lastLogLine())).toMatchObject({
        diagnostics: [{ serverName: "docs", message: expect.stringContaining(CATALOG_ERROR) }],
        cleanupError: expect.stringContaining(CLEANUP_ERROR),
      });
      expect(errors()).toContain(CATALOG_ERROR);
      expect(errors()).toContain(CLEANUP_ERROR);
      expect(errors().indexOf(CATALOG_ERROR)).toBeLessThan(errors().indexOf(CLEANUP_ERROR));
      expect(process.exitCode).toBe(1);
      expect(deleteHeaders).toEqual([{ session: SESSION_ID, protocol: PROTOCOL_VERSION }]);
    });
  });
});
