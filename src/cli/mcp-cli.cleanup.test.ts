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
  mockLog,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";
import { runCliWithExitFinalization } from "./one-shot-exit.js";

const SESSION_ID = "cli-cleanup-fixture-session";
const PROTOCOL_VERSION = "2025-11-25";
const CLEANUP_ERROR = "MCP runtime cleanup could not confirm closure";
const cleanupFailure = new RegExp(`${CLEANUP_ERROR}.*session termination support.*rerun`);
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
let configPath: string;
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
    configPath = path.join(home, ".openclaw", "openclaw.json");
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
const output = (mock: typeof mockLog) => mock.mock.calls.map(([line]) => String(line)).join("\n");
const errors = () => output(mockError);

it.each<[number, boolean, boolean]>([
  [204, true, true],
  [404, true, true],
  [405, true, true],
  [400, false, true],
  [401, false, true],
  [500, false, true],
  [400, false, false],
])("reports DELETE %s cleanup (confirmed=%s, JSON=%s)", async (status, confirmed, json) => {
  deleteStatus = status;
  await probe(json ? ["--json"] : []);
  const result = json ? JSON.parse(lastLogLine()) : undefined;
  if (json) {
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      servers: { docs: { tools: 1 } },
      tools: ["docs__ping"],
      diagnostics: [],
    });
    expect(deleteHeaders).toEqual([{ session: SESSION_ID, protocol: PROTOCOL_VERSION }]);
  } else {
    expect(output(mockLog)).toContain("- docs: 1 tools");
  }
  if (confirmed) {
    expect(result).not.toHaveProperty("cleanupError");
    expect(mockError).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  } else {
    expect(json ? result.cleanupError : output(mockLog)).toMatch(cleanupFailure);
    expect(errors()).toMatch(cleanupFailure);
    expect(process.exitCode).toBe(1);
  }
});

it("includes uncertain cleanup as an error in the Doctor JSON report", async () => {
  await expect(run("doctor", "docs", "--probe", "--json")).rejects.toMatchObject({ code: 1 });
  const issues = expect.arrayContaining([
    { level: "error", message: expect.stringMatching(cleanupFailure) },
  ]);
  expect(JSON.parse(lastLogLine())).toMatchObject({
    ok: false,
    servers: [{ name: "docs", ok: false, issues }],
  });
});

it.each(["add", "configure"] as const)("keeps config on failed %s cleanup", async (command) => {
  if (command === "add") {
    await fs.writeFile(configPath, JSON.stringify({ mcp: { servers: {} } }) + "\n");
  }
  const before = await fs.readFile(configPath, "utf8");
  const args =
    command === "add"
      ? ["add", "docs", "--url", endpoint, "--transport", "streamable-http"]
      : ["configure", "docs", "--include", "ping", "--probe"];
  await expect(run(...args)).rejects.toMatchObject({ code: 1 });
  expect(errors()).toMatch(cleanupFailure);
  expect(errors()).toContain("Configuration was not saved.");
  expect(await fs.readFile(configPath, "utf8")).toBe(before);
  expect(deleteHeaders).toEqual([{ session: SESSION_ID, protocol: PROTOCOL_VERSION }]);
});

it("preserves the discovery diagnostic when cleanup also fails", async () => {
  failCatalog = true;
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
