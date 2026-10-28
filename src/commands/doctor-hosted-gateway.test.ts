import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveFinalDoctorHealthContributions } from "../flows/doctor-health-contributions-final.js";
import * as gatewayCall from "../gateway/call.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../gateway/method-scopes.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
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
  const context = createContext([
    [
      name,
      resolveLeastPrivilegeOperatorScopesForMethod(name)[0]!,
      "test",
      ({ respond }: GatewayRequestHandlerOptions) => {
        respond(true, payload);
      },
    ],
  ]);
  const result = await withPluginRuntimeGatewayContextResolver(() => context, run);
  expect(socketCall.mock.calls.map(([request]) => request.method)).toEqual(methods);
  return result;
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
  const result = await withHosted(
    "diagnostics.stability",
    { events: [{ type: "telemetry.exporter", ...event }] },
    () => checkGatewayHealth({ runtime, cfg: {} }),
    ["status", "channels.status"],
  );
  expect(result).toMatchObject({ healthOk: true, authenticated: true });
  expect(note).toHaveBeenCalledWith("otel · logs · started · stdout", "Telemetry exporters");
});

it("reads cached memory readiness without opening a Gateway socket", async () => {
  const observed = await withHosted("doctor.memory.status", { embedding: { ok: true } }, () =>
    probeGatewayMemoryStatus({ cfg: {} }),
  );
  expect(observed).toMatchObject({ checked: true, ready: true });
});

it("reports hosted pairing inventory without reconnecting or falling back to disk", async () => {
  const result = await withHosted(
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
  const result = await withHosted("status", status, async () =>
    check!.detect({ mode: "doctor", runtime, cfg: {} }),
  );
  expect(result).toEqual([]);
  expect(collectWhatsappResponsivenessHealthFindings).toHaveBeenCalledWith({ cfg: {}, status });
});
