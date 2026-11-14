import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { json as readJson } from "node:stream/consumers";
import { afterAll, afterEach, aroundEach, beforeAll, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  cleanupMcpCliTestState,
  createWorkspace,
  lastLogLine,
  mockError,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";
import { runCliWithExitFinalization } from "./one-shot-exit.js";

const SESSION_ID = "cli-cleanup-fixture-session";
const PROTOCOL_VERSION = "2025-11-25";
const CATALOG_ERROR = "fixture catalog unavailable";
const rpcResults: Record<string, unknown> = {
  initialize: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "cleanup-fixture", version: "1" },
  },
  "tools/list": {
    tools: [{ name: "ping", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
  },
};

let endpoint: string;
let closeFixture: () => Promise<void>;
let deleteStatus = 400;
let failCatalog = false;
type HeaderValue = string | string[] | undefined;
const deleteHeaders: Array<{ session: HeaderValue; protocol: HeaderValue }> = [];

beforeAll(async () => {
  const fixture = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        if (request.method !== "POST") {
          if (request.method === "DELETE") {
            deleteHeaders.push({
              session: request.headers["mcp-session-id"],
              protocol: request.headers["mcp-protocol-version"],
            });
          }
          response.writeHead(request.method === "DELETE" ? deleteStatus : 405).end();
          return;
        }
        void (async () => {
          const message = (await readJson(request)) as { id?: string | number; method: string };
          if (message.method === "notifications/initialized") {
            response.writeHead(202).end();
            return;
          }
          if (message.method === "initialize") {
            response.setHeader("mcp-session-id", SESSION_ID);
          }
          const result = rpcResults[message.method];
          if (!Object.hasOwn(rpcResults, message.method)) {
            response.writeHead(400).end();
            return;
          }
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              ...(message.method === "tools/list" && failCatalog
                ? { error: { code: -32603, message: CATALOG_ERROR } }
                : { result }),
            }),
          );
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

afterAll(async () => await closeFixture?.());

aroundEach(async (runTest) => {
  resetMcpCliTestState();
  deleteStatus = 400;
  failCatalog = false;
  deleteHeaders.length = 0;
  await withTempHome("openclaw-mcp-cleanup-", async (home) => {
    vi.spyOn(process, "cwd").mockReturnValue(await createWorkspace());
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const servers = { docs: { url: endpoint, transport: "streamable-http" } };
    await fs.writeFile(configPath, `${JSON.stringify({ mcp: { servers } })}\n`);
    await runTest();
  });
});
afterEach(cleanupMcpCliTestState);

const run = (...args: string[]) => runMcpCommand(["mcp", ...args]);
async function probe(args: string[]) {
  await runCliWithExitFinalization({
    run: () => run("probe", "docs", ...args),
    onError: (error) => {
      throw error;
    },
  });
}
const errors = () => mockError.mock.calls.map(([line]) => String(line)).join("\n");
function expectCleanup(exitCode?: number) {
  expect(deleteHeaders).toEqual([{ session: SESSION_ID, protocol: PROTOCOL_VERSION }]);
  expect(process.exitCode).toBe(exitCode);
  if (exitCode === undefined) {
    expect(mockError).not.toHaveBeenCalled();
  }
}

it.each([204, 400])("succeeds after DELETE %s", async (status) => {
  deleteStatus = status;
  await probe(["--json"]);
  expect(JSON.parse(lastLogLine())).not.toHaveProperty("cleanupError");
  expectCleanup();
});

it("preserves the discovery failure when DELETE is unconfirmed", async () => {
  failCatalog = true;
  await probe(["--json"]);
  const result = JSON.parse(lastLogLine());
  expect(result).toMatchObject({
    diagnostics: [{ serverName: "docs", message: expect.stringContaining(CATALOG_ERROR) }],
  });
  expect(result).not.toHaveProperty("cleanupError");
  expect(errors()).toContain(CATALOG_ERROR);
  expectCleanup(1);
});
