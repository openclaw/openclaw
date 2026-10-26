import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_RESTART_HEALTH_TIMEOUT_MS } from "../cli/daemon-cli/restart-health.constants.js";
import { resolveFinalDoctorHealthContributions } from "../flows/doctor-health-contributions-final.js";
import * as gatewayCall from "../gateway/call.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../gateway/method-scopes.js";
import { createGatewayMethodRegistry } from "../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { collectDevicePairingHealthFindings } from "./doctor-device-pairing.js";
import { checkGatewayHealth, probeGatewayMemoryStatus } from "./doctor-gateway-health.js";

const { socketCall, note, collectWhatsappResponsivenessHealthFindings } = vi.hoisted(() => ({
  socketCall: vi.fn(),
  note: vi.fn(),
  collectWhatsappResponsivenessHealthFindings: vi.fn(),
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
vi.mock("./doctor-whatsapp-responsiveness.js", () => ({
  collectWhatsappResponsivenessHealthFindings,
}));

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

async function withHosted<T>(
  name: string,
  payload: unknown,
  run: () => Promise<T>,
  methods: string[] = [],
) {
  let requestParams: unknown;
  const registry = createGatewayMethodRegistry([
    {
      name,
      handler: ({ params, respond }: GatewayRequestHandlerOptions) => {
        requestParams = params;
        respond(true, payload);
      },
      owner: { kind: "core" as const, area: "test" },
      scope: resolveLeastPrivilegeOperatorScopesForMethod(name)[0]!,
    },
  ]);
  const context = {
    trackExecution: trackAsyncWork,
    getRuntimeConfig: () => ({}),
    getGatewayMethodRegistry: () => registry,
  } as unknown as GatewayRequestContext;
  const result = await withPluginRuntimeGatewayContextResolver(() => context, run);
  expect(socketCall.mock.calls.map(([request]) => request.method)).toEqual(methods);
  return { result, requestParams };
}

beforeEach(() => {
  socketCall.mockReset().mockRejectedValue(new Error("unexpected Gateway socket"));
  vi.spyOn(gatewayCall, "callGateway").mockImplementation(socketCall);
  note.mockReset();
  collectWhatsappResponsivenessHealthFindings.mockReset().mockReturnValue([]);
});
afterEach(() => vi.restoreAllMocks());

it("reads exporter diagnostics locally while retaining the wire health probes", async () => {
  vi.spyOn(performance, "now").mockReturnValue(0);
  socketCall.mockImplementation(async ({ method }) => {
    if (method === "status" || method === "channels.status") {
      return {};
    }
    throw new Error("unexpected Gateway socket");
  });
  const event = { source: "otel", target: "logs", transport: "stdout", outcome: "started" };
  const { result } = await withHosted(
    "diagnostics.stability",
    { events: [{ type: "telemetry.exporter", ...event }] },
    () => checkGatewayHealth({ runtime, cfg: {} }),
    ["status", "channels.status"],
  );
  expect(result).toMatchObject({ healthOk: true, authenticated: true });
  expect(note).toHaveBeenCalledWith("otel · logs · started · stdout", "Telemetry exporters");
  expect(socketCall).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ timeoutMs: DEFAULT_RESTART_HEALTH_TIMEOUT_MS }),
  );
});

it("reads cached memory readiness without opening a Gateway socket", async () => {
  const observed = await withHosted("doctor.memory.status", { embedding: { ok: true } }, () =>
    probeGatewayMemoryStatus({ cfg: {} }),
  );
  expect(observed).toMatchObject({
    result: { checked: true, ready: true },
    requestParams: { probe: false },
  });
});

it("reports hosted pairing inventory without reconnecting or falling back to disk", async () => {
  const { result } = await withHosted(
    "device.pair.list",
    {
      pending: [{ deviceId: "dev-1", requestId: "req-1" }],
      paired: [],
    },
    () => collectDevicePairingHealthFindings({ cfg: {}, healthOk: true }),
  );
  expect(result).toContainEqual(
    expect.objectContaining({ target: "dev-1:req-1", requirement: "first-time" }),
  );
});

it("passes hosted pressure data to the optional WhatsApp check without reconnecting", async () => {
  const status = { eventLoop: { degraded: true } };
  const contributions = resolveFinalDoctorHealthContributions({
    runSystemdLingerHealth: async () => {},
    detectSystemdLingerFindings: async () => [],
    runShellCompletionHealth: async () => {},
    runGatewayHealthChecks: async () => {},
  });
  const check = contributions.find((entry) => entry.id === "doctor:whatsapp-responsiveness")
    ?.healthChecks[0];
  expect(check).toBeDefined();
  const { result } = await withHosted("status", status, async () =>
    check!.detect({ mode: "doctor", runtime, cfg: {} }),
  );
  expect(result).toEqual([]);
  expect(collectWhatsappResponsivenessHealthFindings).toHaveBeenCalledWith({ cfg: {}, status });
});
