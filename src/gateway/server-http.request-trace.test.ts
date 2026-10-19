import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { buildControlUiSessionEntryUrl } from "./control-ui-session-entry-path.js";
import { createGatewayHttpServer } from "./server-http.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { createGatewayTestRegistry } from "./server/__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };

type HttpServerOptions = Parameters<typeof createGatewayHttpServer>[0];

function createServer(
  options: Pick<HttpServerOptions, "handleHooksRequest"> & Partial<HttpServerOptions>,
) {
  return createGatewayHttpServer({
    clients: new Set(),
    controlUiEnabled: false,
    controlUiBasePath: "",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    resolvedAuth,
    ...options,
  });
}

async function listen(server: ReturnType<typeof createGatewayHttpServer>): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function closeServer(server: ReturnType<typeof createGatewayHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("gateway HTTP request error cleanup", () => {
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
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const reservation = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer({
            controlUiEnabled: true,
            resolvedAuth: { mode: "token", token: "test-token", allowTailscale: false },
            handleHooksRequest: async () => false,
            getRuntimeConfig: () => cfg,
            getGatewayRequestContext: () => context,
          }),
      });
      try {
        const url = `http://127.0.0.1:${reservation.claim.port}${buildControlUiSessionEntryUrl("/chat/worker/absent", "")}&probe=1`;
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
        reservation.listener.closeAllConnections();
        await reservation.releaseListener();
        await reservation.claim.release();
        projection.dispose();
        errorLog.mockRestore();
        recordAgentDatabaseAdmissions([], { source: "startup" });
      }
    });
  });

  it.each([
    { label: "completed", destroy: false },
    { label: "destroyed", destroy: true },
  ])("does not invoke later routes after an earlier response is $label", async ({ destroy }) => {
    const handleWatchNodeRequest = vi.fn(async () => true);
    const server = createServer({
      handleHooksRequest: async (_req, res) => {
        if (destroy) {
          res.destroy();
        } else {
          res.end("already finished");
        }
        return false;
      },
      handleWatchNodeRequest,
      getRuntimeConfig: () => ({}),
    });
    const port = await listen(server);

    try {
      const request = fetch(`http://127.0.0.1:${port}/api/nodes/watch/example`);
      if (destroy) {
        await expect(request).rejects.toMatchObject({ name: "TypeError" });
      } else {
        const response = await request;
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("already finished");
      }
      expect(handleWatchNodeRequest).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await closeServer(server);
    }
  });

  it("preserves a response the route already completed before throwing", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createServer({
      handleHooksRequest: async (_req, res) => {
        res.end("complete");
        throw new Error("route failed after completing a response");
      },
      getRuntimeConfig: () => ({}),
    });
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/hooks/test`, {
        signal: AbortSignal.timeout(1_000),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("complete");
      expect(errorLog).toHaveBeenCalledWith(
        "[gateway-http] unhandled error in request handler:",
        expect.any(Error),
      );
    } finally {
      server.closeAllConnections();
      await closeServer(server);
      errorLog.mockRestore();
    }
  });

  it("aborts an incomplete unframed response after its route throws", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createServer({
      handleHooksRequest: async (_req, res) => {
        res.write("partial");
        throw new Error("route failed after writing a partial response");
      },
      getRuntimeConfig: () => ({}),
    });
    const port = await listen(server);

    try {
      await expect(
        fetch(`http://127.0.0.1:${port}/hooks/test`, {
          signal: AbortSignal.timeout(1_000),
        }).then(async (response) => await response.text()),
      ).rejects.toMatchObject({ name: "TypeError" });
      expect(errorLog).toHaveBeenCalledWith(
        "[gateway-http] unhandled error in request handler:",
        expect.any(Error),
      );
    } finally {
      server.closeAllConnections();
      await closeServer(server);
      errorLog.mockRestore();
    }
  });

  it.each([
    ["hook", "unexpected"],
    ["plugin", "unexpected"],
    ["hook", "pending"],
    ["plugin", "pending"],
    ["hook", "inspection-failed"],
    ["plugin", "inspection-failed"],
  ] as const)(
    "replaces staged %s response metadata after an error (%s)",
    async (owner, failureKind) => {
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
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
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
      const server = createServer({
        handleHooksRequest: owner === "hook" ? route : async () => false,
        handlePluginRequest: owner === "plugin" ? handlePluginRequest : undefined,
        shouldEnforcePluginGatewayAuth: () => false,
        getRuntimeConfig: () => ({}),
      });
      const port = await listen(server);

      try {
        const response = await fetch(`http://127.0.0.1:${port}/failure`, {
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
        expect(response.headers.get("content-encoding")).toBeNull();
        expect(response.headers.get("transfer-encoding")).toBeNull();
        expect(response.headers.get("trailer")).toBeNull();
        expect.soft(response.headers.get("cache-control")).toBe("no-store");
        for (const header of [
          "content-disposition",
          "content-range",
          "content-language",
          "content-location",
          "etag",
          "last-modified",
        ]) {
          expect.soft(response.headers.get(header), header).toBeNull();
        }
        expect(response.headers.get("access-control-allow-origin")).toBe("https://example.test");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      } finally {
        server.closeAllConnections();
        await closeServer(server);
        errorLog.mockRestore();
      }
    },
  );

  it("preserves plugin route ownership when plugin dispatch fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const handlePluginRequest = vi.fn(async () => {
      throw new Error("plugin route dispatch failed");
    });
    const server = createServer({
      handleHooksRequest: async () => false,
      handlePluginRequest,
      getRuntimeConfig: () => ({}),
    });
    const port = await listen(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/plugin-failure`);

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
      expect(handlePluginRequest).toHaveBeenCalledOnce();
      expect(errorLog).toHaveBeenCalledWith(
        "[gateway-http] unhandled error in request handler:",
        expect.objectContaining({ message: "plugin route dispatch failed" }),
      );
    } finally {
      server.closeAllConnections();
      await closeServer(server);
      errorLog.mockRestore();
    }
  });
});
