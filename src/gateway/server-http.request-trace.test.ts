import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildControlUiSessionEntryUrl } from "./control-ui-session-entry-path.js";
import { createGatewayHttpServer } from "./server-http.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { createGatewayTestRegistry } from "./server/__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

const unhandledError = "[gateway-http] unhandled error in request handler:";
function spyError() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  return spy;
}

function createServer(options: Partial<Parameters<typeof createGatewayHttpServer>[0]>) {
  return createGatewayHttpServer({
    clients: new Set(),
    controlUiEnabled: false,
    controlUiBasePath: "",
    resolvedAuth: { mode: "none", allowTailscale: false },
    getRuntimeConfig: () => ({}),
    handleHooksRequest: async () => false,
    ...options,
  });
}

async function listen(options: Parameters<typeof createServer>[0]): Promise<string> {
  const server = createServer(options);
  onTestFinished(() => closeHttpServer(server));
  return await listenLoopback(server);
}

it("retries a protected session-entry probe after background agent preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {}, worker: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: "worker",
      paths: ["/private/worker/openclaw-agent.sqlite"],
      reason: "Startup inspection and preparation are pending",
      pending: true,
    });
    recordAgentDatabaseAdmissions([refusal], { source: "startup" });
    const projection = await createSessionRowProjection({ cfg });
    const context = bindSessionRowProjection(
      createGatewayRequestContext(makeContextParams()),
      () => projection,
    );
    using errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createServer({
      controlUiEnabled: true,
      resolvedAuth: { mode: "token", token: "test-token", allowTailscale: false },
      getRuntimeConfig: () => cfg,
      getGatewayRequestContext: () => context,
    });
    try {
      const url = `${await listenLoopback(server)}${buildControlUiSessionEntryUrl("/chat/worker/absent", "")}&probe=1`;
      const headers = {
        authorization: "Bearer test-token",
        "x-openclaw-scopes": "operator.admin",
      };
      const pending = await fetch(url, { headers });
      expect(pending.status).toBe(503);
      expect(pending.headers.get("retry-after")).toBe("1");
      expect(await pending.text()).toBe("Agent database is starting. Please retry.");
      expect(errorLog).not.toHaveBeenCalled();

      await preparePendingAgentDatabase(refusal, { assertCurrent() {} }, async () => {});
      const recovered = await fetch(url, { headers });
      expect(recovered.status).toBe(403);
      await recovered.text();
    } finally {
      await closeHttpServer(server);
      projection.dispose();
      recordAgentDatabaseAdmissions([], { source: "startup" });
    }
  });
});

it.each([
  ["completed", false],
  ["destroyed", false],
  ["completed", true],
  ["partial", true],
] as const)("honors %s response ownership (route throws: %s)", async (kind, throws) => {
  const body = throws ? (kind === "partial" ? "partial" : "complete") : "already finished";
  const errorLog = throws ? spyError() : undefined;
  const laterRoute = vi.fn(async () => true);
  const origin = await listen({
    handleHooksRequest: async (_req, res) => {
      if (kind === "destroyed") {
        res.destroy();
      } else {
        res[kind === "partial" ? "write" : "end"](body);
      }
      if (throws) {
        throw new Error(`route failed after ${kind} response`);
      }
      return false;
    },
    handleWatchNodeRequest: throws ? undefined : laterRoute,
  });
  const routePath = throws ? "/hooks/test" : "/api/nodes/watch/example";
  const response = fetch(
    `${origin}${routePath}`,
    throws ? { signal: AbortSignal.timeout(1_000) } : undefined,
  );
  if (kind === "completed") {
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.text()).toBe(body);
  } else {
    await expect(response.then((result) => result.text())).rejects.toMatchObject({
      name: "TypeError",
    });
  }
  if (errorLog) {
    expect(errorLog).toHaveBeenCalledWith(unhandledError, expect.any(Error));
  } else {
    expect(laterRoute).not.toHaveBeenCalled();
  }
});

it.each([
  ["hook", "unexpected"],
  ["plugin", "unexpected"],
  ["hook", "pending"],
  ["plugin", "pending"],
  ["hook", "inspection-failed"],
  ["plugin", "inspection-failed"],
] as const)("resets staged %s metadata (%s)", async (owner, failureKind) => {
  const pending = failureKind === "pending";
  const statusText = pending ? "Service Unavailable" : "Internal Server Error";
  const body = pending ? "Agent database is starting. Please retry." : statusText;
  const failure =
    failureKind === "unexpected"
      ? new Error("route failed before writing a response")
      : new AgentDatabaseAdmissionError(
          createAgentDatabaseInspectionRefusal({
            agentId: "worker",
            paths: ["/private/worker/openclaw-agent.sqlite"],
            reason: "Private inspection details",
            pending,
          }),
        );
  const headers = {
    "Content-Length": "1000",
    "Content-Encoding": "gzip",
    "Transfer-Encoding": "chunked",
    Trailer: "Digest",
    "Cache-Control": "public, max-age=31536000",
    "Content-Disposition": "attachment; filename=report.txt",
    "Content-Range": "bytes 0-99/1000",
    "Content-Language": "fr",
    "Content-Location": "/report.txt",
    ETag: '"report-version"',
    "Last-Modified": "Wed, 26 Aug 2026 12:00:00 GMT",
  };
  const errorLog = spyError();
  const route = async (_req: IncomingMessage, res: ServerResponse) => {
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
    res.statusMessage = "Download Ready";
    res.setHeader("Access-Control-Allow-Origin", "https://example.test");
    throw failure;
  };
  const warn = vi.fn();
  const handlePluginRequest = createGatewayPluginRequestHandler({
    registry: createGatewayTestRegistry({
      httpRoutes: [
        {
          pluginId: "route",
          source: "route",
          path: "/failure",
          auth: "plugin",
          match: "exact",
          handler: route,
        },
      ],
    }),
    log: { warn } as unknown as Parameters<typeof createGatewayPluginRequestHandler>[0]["log"],
  });
  const origin = await listen({
    handleHooksRequest: owner === "hook" ? route : async () => false,
    handlePluginRequest: owner === "plugin" ? handlePluginRequest : undefined,
    shouldEnforcePluginGatewayAuth: () => false,
  });
  const response = await fetch(`${origin}/failure`, {
    signal: AbortSignal.timeout(1_000),
  });

  expect(response.status).toBe(pending ? 503 : 500);
  expect(response.statusText).toBe(statusText);
  expect(await response.text()).toBe(body);
  expect(response.headers.get("retry-after")).toBe(pending ? "1" : null);
  expect(errorLog).toHaveBeenCalledTimes(!pending && owner === "hook" ? 1 : 0);
  expect(warn).toHaveBeenCalledTimes(!pending && owner === "plugin" ? 1 : 0);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
  expect.soft(response.headers.get("cache-control")).toBe("no-store");
  for (const header of Object.keys(headers).filter(
    (name) => !["Content-Length", "Cache-Control"].includes(name),
  )) {
    expect(response.headers.get(header), header).toBeNull();
  }
  expect(response.headers.get("access-control-allow-origin")).toBe("https://example.test");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});

it("preserves plugin route ownership when plugin dispatch fails", async () => {
  const errorLog = spyError();
  const handlePluginRequest = vi.fn(async () => {
    throw new Error("plugin route dispatch failed");
  });
  const origin = await listen({ handlePluginRequest });
  const response = await fetch(`${origin}/plugin-failure`);

  expect(response.status).toBe(500);
  expect(await response.text()).toBe("Internal Server Error");
  expect(handlePluginRequest).toHaveBeenCalledOnce();
  expect(errorLog).toHaveBeenCalledWith(
    unhandledError,
    expect.objectContaining({ message: "plugin route dispatch failed" }),
  );
});
