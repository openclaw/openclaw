import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import * as bundleMcpConfig from "../agents/agent-bundle-mcp-runtime-config.js";
import { configFor, modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock, reserveTestPortListener } from "../test-utils/port-claims.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
});

type Scenario = {
  name: string;
  severity: "warning" | "error";
  reason: string;
  transport?: "sse";
  httpStatus?: number;
  legacyPost?: boolean;
  rpcFailure?: { method: "initialize" | "tools/list"; code: number };
};

const scenarios: Scenario[] = [
  { name: "closed stdio transport", severity: "error", reason: "Connection closed" },
  { name: "missing local executable", severity: "error", reason: "ENOENT" },
  { name: "refused HTTP connection", severity: "warning", reason: "fetch failed" },
  { name: "catalog deadline", severity: "warning", reason: "timed out after 10000ms" },
  { name: "cyclic pagination", severity: "error", reason: "repeated pagination cursor" },
  ...([503, 401, 404] as const).map((status) => ({
    name: `SSE HTTP ${status}`,
    severity: status === 404 ? ("error" as const) : ("warning" as const),
    reason: String(status),
    transport: "sse" as const,
    httpStatus: status,
  })),
  {
    name: "HTTP insufficient scope",
    severity: "warning",
    reason: 'Insufficient scope: required "fixture:read"',
    httpStatus: 403,
  },
  {
    name: "untyped legacy SSE POST 500",
    severity: "error",
    reason: "HTTP 500",
    transport: "sse",
    httpStatus: 500,
    legacyPost: true,
  },
  ...([-32000, -32001] as const).flatMap((code) =>
    (["initialize", "tools/list"] as const).map((method) => ({
      name: `${method} remote protocol error ${code}`,
      severity: "error" as const,
      reason: `fixture protocol failure ${code}`,
      rpcFailure: { method, code },
    })),
  ),
];

it.each(scenarios)("reports $name through the real Doctor MCP owner", async (scenario) => {
  await withOpenClawTestState({ env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } }, async (state) => {
    const { name, severity, reason, rpcFailure, transport, httpStatus, legacyPost } = scenario;
    const requests: string[] = [];
    let monotonicTime = 0;
    const hasHttpServer =
      name === "catalog deadline" || name === "cyclic pagination" || rpcFailure || httpStatus;
    // Cross the collector deadline at the actual HTTP boundary without sleeping,
    // changing configured budgets, or mocking the detector/error classifier.
    if (name === "catalog deadline") {
      vi.spyOn(performance, "now").mockImplementation(() => monotonicTime);
    }
    const reservation = hasHttpServer
      ? await reserveTestPortListener({
          offsets: [0],
          createListener: () =>
            http.createServer((request, response) => {
              if (httpStatus !== undefined) {
                requests.push(request.method ?? "");
                if (legacyPost && request.method === "GET") {
                  response.writeHead(200, { "content-type": "text/event-stream" });
                  response.write("event: endpoint\ndata: /messages\n\n");
                  return;
                }
                response.writeHead(httpStatus, {
                  "content-type": "text/plain",
                  ...(httpStatus === 403
                    ? {
                        "www-authenticate":
                          'Bearer error="insufficient_scope", scope="fixture:read", error_description="fixture scope denied"',
                      }
                    : {}),
                });
                response.end("fixture HTTP refusal");
                return;
              }
              if (request.method !== "POST") {
                response.writeHead(405).end();
                return;
              }
              let body = "";
              request.setEncoding("utf8");
              request.on("data", (chunk: string) => {
                body += chunk;
              });
              request.on("end", () => {
                const message = JSON.parse(body) as {
                  id?: string | number;
                  method: string;
                  params?: { protocolVersion?: string };
                };
                requests.push(message.method);
                if (message.id === undefined) {
                  response.writeHead(202).end();
                  return;
                }
                if (message.method === "tools/list" && name === "catalog deadline") {
                  monotonicTime += 10_000;
                }
                const result =
                  message.method === "initialize"
                    ? {
                        protocolVersion: message.params?.protocolVersion,
                        capabilities: { tools: {} },
                        serverInfo: { name: "doctor-fixture", version: "1.0.0" },
                      }
                    : {
                        tools: [],
                        ...(name === "cyclic pagination" ? { nextCursor: "repeat" } : {}),
                      };
                const payload =
                  rpcFailure?.method === message.method
                    ? { error: { code: rpcFailure.code, message: reason } }
                    : { result };
                response.setHeader("content-type", "application/json");
                response
                  .writeHead(200)
                  .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload }));
              });
            }),
        })
      : undefined;
    const refusedClaim =
      name === "refused HTTP connection" ? await acquireTestPortBlock({ offsets: [0] }) : undefined;
    try {
      const configuredServer =
        name === "closed stdio transport"
          ? { command: process.execPath, args: ["-e", "process.exit(1)"] }
          : name === "missing local executable"
            ? { command: state.path("missing-executable") }
            : {
                url: `http://127.0.0.1:${reservation?.claim.port ?? refusedClaim!.port}/mcp`,
                transport: transport ?? ("streamable-http" as const),
              };
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "alpha" }, model: "fixture/local" },
          entries: { alpha: { workspace: state.path("alpha") } },
        },
        ...configFor("fixture", "http://127.0.0.1:1/v1", {
          api: "openai-completions",
          models: [modelDefinition("local", { name: "Local fixture", reasoning: false })],
        }),
        plugins: { slots: { memory: "none" } },
        mcp: { servers: { broken: configuredServer } },
      };
      const check = CORE_HEALTH_CHECKS.find(
        (entry) => entry.id === "core/doctor/runtime-tool-schemas",
      );
      expect(check).toBeDefined();
      const findings = await check!.detect({
        mode: "lint",
        cfg,
        runtime: defaultRuntime,
        env: process.env,
      });
      const finding = findings.find((entry) => entry.path === "mcp.servers.broken");
      expect(finding).toMatchObject({
        checkId: "core/doctor/runtime-tool-schemas",
        severity,
        requirement: expect.stringContaining(reason),
      });
      expect(finding?.errorCode).toBe(
        severity === "warning" ? "mcp-service-unavailable" : undefined,
      );
      if (severity === "warning") {
        expect(findings.filter((entry) => entry.severity === "error")).toEqual([]);
      }
      if (name === "catalog deadline" || name === "cyclic pagination") {
        expect(requests).toContain("initialize");
        expect(requests.filter((method) => method === "tools/list")).toHaveLength(
          name === "catalog deadline" ? 1 : 2,
        );
      }
      if (rpcFailure) {
        expect(requests).toContain(rpcFailure.method);
      }
      if (httpStatus !== undefined) {
        expect(requests).toContain(transport === "sse" && !legacyPost ? "GET" : "POST");
        if (legacyPost) {
          expect(requests).toContain("GET");
        }
      }
    } finally {
      if (reservation) {
        reservation.listener.closeAllConnections();
        try {
          await reservation.releaseListener();
        } finally {
          await reservation.claim.release();
        }
      }
      await refusedClaim?.release();
    }
  });
});

it.each([
  {
    first: "availability",
    second: "invalid",
    severity: "error",
    initialized: ["/availability", "/invalid"],
  },
  { first: "oauth", second: "invalid", severity: "error", initialized: ["/invalid"] },
  {
    first: "invalid",
    second: "availability",
    severity: "error",
    initialized: ["/invalid", "/availability"],
  },
  {
    first: "availability",
    second: "availability",
    severity: "warning",
    initialized: ["/availability"],
  },
] as const)(
  "keeps the strongest MCP finding across $first then $second agent catalogs",
  async ({ first, second, severity, initialized }) => {
    await withOpenClawTestState(
      { env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const requests: Array<{ route: string; method: string }> = [];
        const reservation = await reserveTestPortListener({
          offsets: [0],
          createListener: () =>
            http.createServer((request, response) => {
              if (request.method !== "POST") {
                response.writeHead(405).end();
                return;
              }
              let body = "";
              request.setEncoding("utf8");
              request.on("data", (chunk: string) => {
                body += chunk;
              });
              request.on("end", () => {
                const message = JSON.parse(body) as {
                  id?: string | number;
                  method: string;
                  params?: { protocolVersion?: string };
                };
                const route = request.url ?? "";
                requests.push({ route, method: message.method });
                if (message.id === undefined) {
                  response.writeHead(202).end();
                  return;
                }
                if (message.method === "tools/list" && route === "/availability") {
                  response.writeHead(503).end("fixture temporarily unavailable");
                  return;
                }
                const payload =
                  message.method === "initialize"
                    ? {
                        result: {
                          protocolVersion: message.params?.protocolVersion,
                          capabilities: { tools: {} },
                          serverInfo: { name: "doctor-context-fixture", version: "1.0.0" },
                        },
                      }
                    : { error: { code: -32000, message: "fixture invalid tools catalog" } };
                response.setHeader("content-type", "application/json");
                response
                  .writeHead(200)
                  .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...payload }));
              });
            }),
        });
        try {
          const cfg: OpenClawConfig = {
            agents: {
              ownership: "explicit",
              defaults: { systemAgent: { agentId: "alpha" }, model: "fixture/local" },
              entries: {
                alpha: { workspace: state.path("alpha") },
                beta: { workspace: state.path("beta") },
              },
            },
            ...configFor("fixture", "http://127.0.0.1:1/v1", {
              api: "openai-completions",
              models: [modelDefinition("local", { name: "Local fixture", reasoning: false })],
            }),
            plugins: { slots: { memory: "none" } },
          };
          const loadSessionMcpConfig = bundleMcpConfig.loadSessionMcpConfig;
          // Exercise distinct declarations at the loaded-catalog boundary; this is not
          // an end-to-end workspace discovery fixture. Production fingerprinting,
          // policy, transport, error classification, and aggregation remain composed.
          vi.spyOn(bundleMcpConfig, "loadSessionMcpConfig").mockImplementation((params) => {
            const route = params.workspaceDir === state.path("alpha") ? first : second;
            return loadSessionMcpConfig({
              ...params,
              loaded: {
                mcpServers: {
                  shared: {
                    url: `http://127.0.0.1:${reservation.claim.port}/${route}`,
                    transport: "streamable-http",
                    ...(route === "oauth" ? { auth: "oauth" } : {}),
                  },
                },
                diagnostics: [],
                prepareDataDirsByServer: {},
              },
            });
          });
          const check = CORE_HEALTH_CHECKS.find(
            (entry) => entry.id === "core/doctor/runtime-tool-schemas",
          );
          const findings = await check!.detect({
            mode: "lint",
            cfg,
            runtime: defaultRuntime,
            env: process.env,
          });
          expect(
            requests.filter((request) => request.method === "initialize").map(({ route }) => route),
          ).toEqual(initialized);
          expect(
            requests.filter((request) => request.method === "tools/list").map(({ route }) => route),
          ).toEqual(initialized);
          expect(requests.some(({ route }) => route === "/oauth")).toBe(false);
          expect(findings.filter((finding) => finding.path === "mcp.servers.shared")).toEqual([
            expect.objectContaining({
              severity,
              requirement: expect.stringContaining(
                severity === "error"
                  ? "fixture invalid tools catalog"
                  : "Error POSTing to endpoint: [redacted response body]",
              ),
            }),
          ]);
        } finally {
          reservation.listener.closeAllConnections();
          try {
            await reservation.releaseListener();
          } finally {
            await reservation.claim.release();
          }
        }
      },
    );
  },
);
