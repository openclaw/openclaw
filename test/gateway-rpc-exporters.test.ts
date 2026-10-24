// Root-owned integration combines the real Gateway with public telemetry plugin surfaces.
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createGatewayMethodDescriptorsFromHandlers } from "../src/gateway/methods/registry.js";
import { createLazyCoreHandlers } from "../src/gateway/server-methods/lazy-core-handlers.js";
import {
  connectOk,
  getGatewayTestPort,
  installGatewayTestHooks,
  onceMessage,
  resetTestPluginRegistry,
  rpcReq,
  setTestPluginRegistry,
  startTestGatewayServer,
  trackConnectChallengeNonce,
} from "../src/gateway/test-helpers.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../src/infra/diagnostic-events.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
} from "../src/plugin-sdk/plugin-entry.js";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "../src/plugin-sdk/plugin-test-api.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import { startLocalOtlpReceiver } from "./e2e/qa-lab/runtime/otel-test-support.js";

installGatewayTestHooks({ scope: "suite" });

async function sendTraceRequest(ws: WebSocket, id: string, traceparent: string) {
  const response = onceMessage<{ type: "res"; id: string; ok: boolean }>(
    ws,
    (value) => value.type === "res" && value.id === id,
  );
  ws.send(JSON.stringify({ type: "req", id, method: "test.trace", params: {}, traceparent }));
  return await response;
}

function rpcMetric(name: string, value?: number, method = "test.trace") {
  return `openclaw_gateway_rpc_${name}{method="${method}"}${value === undefined ? "" : ` ${value}`}`;
}

function metricValue(body: string, name: string) {
  const line = body.split("\n").find((entry) => entry.startsWith(`${name} `));
  return Number(line?.split(" ").at(-1));
}

async function assertGatewayExporters() {
  const [{ createDiagnosticsOtelService }, { default: prometheusPlugin }] = await Promise.all([
    import("../extensions/diagnostics-otel/runtime-api.js"),
    import("../extensions/diagnostics-prometheus/index.js"),
  ]);
  const receiver = startLocalOtlpReceiver();
  const familyReached = createDeferredCore<number>();
  const releaseFamily = createDeferredCore();
  const releaseHandler = createDeferredCore();
  const otel = createDiagnosticsOtelService();
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  let ws: WebSocket | undefined;
  let unsubscribe: (() => void) | undefined;
  let serviceContext: OpenClawPluginServiceContextV2 | undefined;
  let prometheus: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  const scheduler = createTestPluginServiceScheduler();
  const cleanupFailures: unknown[] = [];
  try {
    const receiverPort = await receiver.listen();
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers = createLazyCoreHandlers({
      methods: ["test.trace"],
      loadHandlers: async () => {
        familyReached.resolve(performance.now());
        await releaseFamily.promise;
        return {
          "test.trace": async ({ req, respond }) => {
            respond(true, { accepted: true });
            if (req.id === "held-rpc-proof") {
              await releaseHandler.promise;
              respond(true, { complete: true });
            }
          },
        };
      },
    });
    // Registry descriptors are normalized inputs; plugin-owned methods default to a required profile.
    registry.gatewayMethodDescriptors = createGatewayMethodDescriptorsFromHandlers({
      handlers: registry.gatewayHandlers,
      owner: { kind: "plugin", pluginId: "synthetic-rpc-proof" },
      defaultScope: "operator.admin",
    }).map((descriptor) => Object.assign(descriptor, { profileAccess: "required" as const }));
    const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
    prometheusPlugin.register(
      createTestPluginApi({
        registerService: (service) => services.push(service),
        registerHttpRoute: (route) =>
          registry.httpRoutes.push({
            ...route,
            match: route.match ?? "exact",
            pluginId: "diagnostics-prometheus",
            source: "synthetic-rpc-proof",
          }),
      }),
    );
    prometheus = services[0];
    if (!prometheus) {
      throw new Error("Prometheus plugin did not register its service");
    }
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("Gateway test hooks did not create an isolated state directory");
    }
    const events: Extract<DiagnosticEventPayload, { type: "gateway.rpc" }>[] = [];
    const windows: Extract<DiagnosticEventPayload, { type: "gateway.event_loop.sample" }>[] = [];
    unsubscribe = onTrustedInternalDiagnosticEvent(
      (event) => {
        if (event.type === "gateway.rpc") {
          events.push(event);
        } else if (event.type === "gateway.event_loop.sample") {
          windows.push(event);
        }
      },
      { include: ["gateway.rpc", "gateway.event_loop.sample"] },
    );
    const endpoint = `http://127.0.0.1:${receiverPort}`;
    serviceContext = {
      scheduler,
      config: { diagnostics: { otel: { enabled: true, endpoint, flushIntervalMs: 1000 } } },
      stateDir,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      // Source-harness capability: package installation and official provenance are separate proof.
      internalDiagnostics: {
        emit: emitTrustedDiagnosticEventWithPrivateData,
        onEvent: onTrustedInternalDiagnosticEvent,
      },
    };
    const token = "synthetic-rpc-exporter-proof-token";
    const port = await getGatewayTestPort();
    const firstTraceId = "11111111111111111111111111111111";
    const firstTraceparent = `00-${firstTraceId}-1111111111111111-01`;
    const secondTraceId = "22222222222222222222222222222222";
    const rpcSpanPrefix = "openclaw.gateway.rpc.";
    const rpcSpans = (traceId?: string) =>
      receiver.capturedSpans.filter(
        (span) => span.name.startsWith(rpcSpanPrefix) && (!traceId || span.traceId === traceId),
      );
    const tracePhase = (traceId: string, phase: string) =>
      events.find((event) => event.trace?.traceId === traceId && event.phase === phase);
    const unknownDispatches = () =>
      events.filter((event) => event.method === "other" && event.phase === "dispatch");
    const waitFor = (assertion: () => unknown) => vi.waitFor(assertion, { timeout: 10_000 });
    const fetchGateway = (route: string, authenticated = true) =>
      fetch(`http://127.0.0.1:${port}${route}`, {
        headers: authenticated ? { Authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    const scrape = async () => {
      const response = await fetchGateway("/api/diagnostics/prometheus");
      expect(response.status).toBe(200);
      return await response.text();
    };
    const waitForDispatch = async (traceId: string) => {
      await waitFor(() => expect(tracePhase(traceId, "dispatch")).toBeDefined());
      await waitForDiagnosticEventsDrained();
    };
    setTestPluginRegistry(registry);
    server = await startTestGatewayServer(port, {
      auth: { mode: "token", token },
      bind: "loopback",
      controlUiEnabled: false,
    });
    await prometheus.start(serviceContext);
    await otel.start(serviceContext);
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
    trackConnectChallengeNonce(ws);
    await once(ws, "open", { signal: AbortSignal.timeout(10_000) });
    await connectOk(ws, { token, traceparent: firstTraceparent });
    const denied = await fetchGateway("/api/diagnostics/prometheus", false);
    expect(denied.status).toBe(401);
    await denied.arrayBuffer();

    const firstResponse = sendTraceRequest(ws, "held-rpc-proof", firstTraceparent);
    const familyStartedAt = await Promise.race([
      familyReached.promise,
      firstResponse.then(() => {
        throw new Error("response sent before handler family preparation");
      }),
    ]);
    await waitForDiagnosticEventsDrained();
    const preparing = await scrape();
    expect(preparing).toContain(rpcMetric("requests_total", 1));
    expect(preparing).not.toContain(rpcMetric("first_response_seconds_count"));
    expect(preparing).not.toContain(rpcMetric("handler_seconds_count"));
    const familyHeldMs = performance.now() - familyStartedAt;
    releaseFamily.resolve();
    expect(await firstResponse).toMatchObject({ ok: true });
    await waitForDiagnosticEventsDrained();
    const acknowledged = await scrape();
    expect(acknowledged).toContain(rpcMetric("requests_total", 1));
    expect(acknowledged).toContain(rpcMetric("first_response_seconds_count", 1));
    expect(acknowledged).not.toContain(rpcMetric("handler_seconds_count"));
    await waitFor(() =>
      expect(rpcSpans(firstTraceId).map((span) => span.name)).toEqual([`${rpcSpanPrefix}response`]),
    );

    // The real readiness reader completes the existing monitor's window while
    // the acknowledged RPC remains held; no synthetic diagnostic event is injected.
    await delay(1_100);
    const readiness = await fetchGateway("/readyz");
    expect(readiness.status).toBe(200);
    const { eventLoop } = (await readiness.json()) as {
      eventLoop?: { intervalMs: number; delayMaxMs: number };
    };
    expect(eventLoop?.intervalMs).toBeGreaterThanOrEqual(1_000);
    await waitForDiagnosticEventsDrained();
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.every((window) => window.trace === undefined)).toBe(true);
    const windowMetrics = (body: string) => ({
      count: metricValue(body, "openclaw_gateway_event_loop_delay_max_seconds_count"),
      sum: metricValue(body, "openclaw_gateway_event_loop_delay_max_seconds_sum"),
      observed: metricValue(body, "openclaw_gateway_event_loop_observed_seconds_total"),
    });
    const completedWindow = windowMetrics(await scrape());
    expect(completedWindow.count).toBeGreaterThan(0);
    expect(completedWindow.sum).toBeGreaterThanOrEqual(eventLoop!.delayMaxMs / 1000 - 1e-9);
    expect(completedWindow.observed).toBeGreaterThanOrEqual(eventLoop!.intervalMs / 1000 - 1e-9);

    expect(
      await sendTraceRequest(ws, "concurrent-rpc-proof", `00-${secondTraceId}-2222222222222222-01`),
    ).toMatchObject({ ok: true });
    await waitForDispatch(secondTraceId);
    expect(tracePhase(firstTraceId, "handler")).toBeUndefined();
    releaseHandler.resolve();
    await waitForDispatch(firstTraceId);
    const settled = await scrape();
    for (const metric of ["first_response", "handler", "admission", "queue_wait"]) {
      expect(settled).toContain(rpcMetric(`${metric}_seconds_count`, 2));
    }
    const measured = events.filter((event) => event.method === "test.trace");
    expect(settled).toContain(rpcMetric("response_bytes_count", 3));
    expect(
      measured.filter((event) => event.phase === "response").map((event) => event.firstResponse),
    ).toEqual([true, true, false]);
    for (const [metric, phase] of [
      ["first_response", "response"],
      ["handler", "handler"],
    ] as const) {
      const totalMs = measured.reduce(
        (sum, event) =>
          sum +
          (event.phase === phase && !(event.phase === "response" && event.firstResponse === false)
            ? event.durationMs
            : 0),
        0,
      );
      expect(metricValue(settled, rpcMetric(`${metric}_seconds_sum`))).toBeCloseTo(
        totalMs / 1000,
        6,
      );
    }
    for (const traceId of [firstTraceId, secondTraceId]) {
      const handler = tracePhase(traceId, "handler");
      const response = tracePhase(traceId, "response");
      if (handler?.phase !== "handler" || response?.phase !== "response") {
        throw new Error("missing real request timing observations");
      }
      if (traceId === firstTraceId) {
        expect(handler.admissionMs).toBeGreaterThanOrEqual(familyHeldMs);
      }
      expect(handler.admissionMs).toBeLessThanOrEqual(response.durationMs);
      expect(handler.admissionMs + handler.durationMs).toBeGreaterThanOrEqual(response.durationMs);
    }

    // Arbitrary method names share one bucket; this exercises retention through real ingress.
    // The exporter unit test separately saturates the hard 2048-series cap and verifies drops.
    expect(await rpcReq(ws, "private-rpc-proof-0", {})).toMatchObject({ ok: false });
    await waitFor(() => expect(unknownDispatches()).toHaveLength(1));
    await waitForDiagnosticEventsDrained();
    const unknownSeries = (body: string) =>
      body
        .split("\n")
        .filter(
          (line) => line.startsWith("openclaw_gateway_rpc_") && line.includes('method="other"'),
        )
        .map((line) => line.slice(0, line.lastIndexOf(" ")))
        .toSorted();
    const initialUnknown = unknownSeries(await scrape());
    for (let index = 1; index <= 64; index++) {
      expect(await rpcReq(ws, `private-rpc-proof-${index}`, {})).toMatchObject({ ok: false });
    }
    await waitFor(() => expect(unknownDispatches()).toHaveLength(65));
    await waitForDiagnosticEventsDrained();
    const flooded = await scrape();
    const retainedWindows = windowMetrics(flooded);
    for (const key of ["count", "sum", "observed"] as const) {
      expect(retainedWindows[key]).toBeGreaterThanOrEqual(completedWindow[key]);
    }
    expect(flooded).toContain(rpcMetric("requests_total", 65, "other"));
    expect(unknownSeries(flooded)).toEqual(initialUnknown);
    expect(flooded).not.toMatch(
      /private-rpc-proof|held-rpc-proof|concurrent-rpc-proof|11111111111111111111111111111111|22222222222222222222222222222222/,
    );
    await otel.stop?.(serviceContext);
    for (const [traceId, parentSpanId] of [
      [firstTraceId, "1111111111111111"],
      [secondTraceId, "2222222222222222"],
    ] as const) {
      const spans = rpcSpans(traceId);
      expect(spans.map((span) => span.name).toSorted()).toEqual(
        ["dispatch", "handler", "response"].map((phase) => `${rpcSpanPrefix}${phase}`),
      );
      expect(spans.every((span) => span.parentSpanId === parentSpanId)).toBe(true);
      for (const span of spans) {
        const event = tracePhase(traceId, span.name.slice(rpcSpanPrefix.length));
        expect(span.endTimeMs).toBe(event?.ts);
      }
    }
    expect(receiver.capturedMetrics.map((metric) => metric.name)).toEqual(
      expect.arrayContaining([
        "openclaw.gateway.rpc.requests",
        "openclaw.gateway.rpc.first_response_ms",
        "openclaw.gateway.rpc.handler_ms",
        "openclaw.gateway.rpc.admission_ms",
        "openclaw.gateway.rpc.queue_wait_ms",
        "openclaw.gateway.rpc.outcomes",
        "openclaw.gateway.event_loop.delay_max_ms",
        "openclaw.gateway.event_loop.observed_ms",
      ]),
    );
    expect(receiver.capturedSpans.some((span) => span.name.includes("event_loop"))).toBe(false);
    expect(JSON.stringify(rpcSpans().map((span) => span.attributes))).not.toMatch(
      /private-rpc-proof|held-rpc-proof|concurrent-rpc-proof/,
    );
  } finally {
    releaseFamily.resolve();
    releaseHandler.resolve();
    // Drain real requests before flushing exporters, and leave the receiver alive for that flush.
    // Attempt every owner cleanup even if an earlier close fails during a failed assertion.
    for (const cleanup of [
      () => ws?.terminate(),
      () => server?.close(),
      () => waitForDiagnosticEventsDrained(),
      () => unsubscribe?.(),
      () => scheduler.beginClose(),
      () => serviceContext && otel.stop?.(serviceContext),
      () => serviceContext && prometheus?.stop?.(serviceContext),
      () => scheduler.stop(),
      () => receiver.close(),
      () => resetTestPluginRegistry(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  }
  // An assertion failure propagates unchanged after every cleanup has been attempted.
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "RPC exporter proof cleanup failed");
  }
}

it(
  "exports RPC phases and completed event-loop windows through the same Gateway exporters",
  () =>
    withEnvAsync(
      {
        // Restore inherited SDK/proxy options only after all owned resources close.
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter(
              (key) =>
                key.startsWith("OTEL_") ||
                key.startsWith("OPENCLAW_PROXY_") ||
                /^(?:https?|all|no)_proxy$/i.test(key) ||
                key === "NODE_USE_ENV_PROXY",
            )
            .map((key) => [key, undefined]),
        ),
        OPENCLAW_OTEL_PRELOADED: "0",
        OTEL_SDK_DISABLED: "false",
        OTEL_NODE_RESOURCE_DETECTORS: "none",
      },
      assertGatewayExporters,
    ),
  120_000,
);
