// HTTP request trace tests ensure gateway request scope reaches logs and
// diagnostic events for per-request debugging.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";
import { withTempConfig } from "./test-temp-config.js";

const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };
const upstreamTraceId = "11111111111111111111111111111111";
const upstreamSpanId = "2222222222222222";

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

async function captureRequestTrace(params: {
  traceparent?: string;
  trustedProxies?: string[];
}): Promise<DiagnosticTraceContext | undefined> {
  let activeTraceInHandler: DiagnosticTraceContext | undefined;

  await withTempConfig({
    cfg: {
      gateway: {
        auth: { mode: "none" },
        ...(params.trustedProxies ? { trustedProxies: params.trustedProxies } : {}),
      },
    },
    run: async () => {
      const httpServer = createGatewayHttpServer({
        clients: new Set(),
        controlUiEnabled: false,
        controlUiBasePath: "/__control__",
        openAiChatCompletionsEnabled: false,
        openResponsesEnabled: false,
        handleHooksRequest: async (_req, res) => {
          activeTraceInHandler = getActiveDiagnosticTraceContext();
          res.statusCode = 204;
          res.end();
          return true;
        },
        resolvedAuth,
      });
      const port = await listen(httpServer);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/hook`, {
          headers: params.traceparent ? { traceparent: params.traceparent } : undefined,
        });
        expect(response.status).toBe(204);
      } finally {
        await closeServer(httpServer);
      }
    },
  });

  return activeTraceInHandler;
}

afterEach(() => {
  resetDiagnosticEventsForTest();
  setLoggerOverride(null);
  resetLogger();
});

describe("gateway HTTP request trace scope", () => {
  it("threads active request trace through logs and diagnostics", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-request-trace-"));
    const logPath = path.join(dir, "gateway.log");
    const events: Array<{ trace?: DiagnosticTraceContext; type: string }> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ trace: event.trace, type: event.type });
    });
    let activeTraceInHandler: DiagnosticTraceContext | undefined;

    await withTempConfig({
      cfg: { gateway: { auth: { mode: "none" } } },
      run: async () => {
        setLoggerOverride({ level: "info", file: logPath });
        const httpServer = createGatewayHttpServer({
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async (_req, res) => {
            activeTraceInHandler = getActiveDiagnosticTraceContext();
            getLogger().info({ route: "/hook" }, "handled request trace");
            emitDiagnosticEvent({ type: "message.queued", source: "gateway-test" });
            res.statusCode = 204;
            res.end();
            return true;
          },
          resolvedAuth,
        });
        const port = await listen(httpServer);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/hook`);
          expect(response.status).toBe(204);
        } finally {
          await closeServer(httpServer);
        }
      },
    });

    stop();
    try {
      expect(activeTraceInHandler?.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(activeTraceInHandler?.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(events).toEqual([{ trace: activeTraceInHandler, type: "message.queued" }]);

      const traceRecord = fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((record) => record.message === "handled request trace");
      expect(traceRecord?.traceId).toBe(activeTraceInHandler?.traceId);
      expect(traceRecord?.spanId).toBe(activeTraceInHandler?.spanId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues traceparent from a trusted HTTP peer as a child span", async () => {
    const activeTrace = await captureRequestTrace({
      traceparent: `00-${upstreamTraceId}-${upstreamSpanId}-00`,
      trustedProxies: ["127.0.0.1"],
    });

    expect(activeTrace).toMatchObject({
      traceId: upstreamTraceId,
      parentSpanId: upstreamSpanId,
      traceFlags: "00",
    });
    expect(activeTrace?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(activeTrace?.spanId).not.toBe(upstreamSpanId);
  });

  it.each([
    {
      name: "untrusted peer",
      traceparent: `00-${upstreamTraceId}-${upstreamSpanId}-01`,
      trustedProxies: ["10.0.0.1"],
    },
    {
      name: "malformed traceparent",
      traceparent: "not-a-traceparent",
      trustedProxies: ["127.0.0.1"],
    },
  ])("creates a fresh trace for $name", async ({ traceparent, trustedProxies }) => {
    const activeTrace = await captureRequestTrace({ traceparent, trustedProxies });

    expect(activeTrace?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(activeTrace?.traceId).not.toBe(upstreamTraceId);
    expect(activeTrace?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(activeTrace?.parentSpanId).toBeUndefined();
  });
});
