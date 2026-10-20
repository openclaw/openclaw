import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RESTART_HEALTH_TIMEOUT_MS } from "../cli/daemon-cli/restart-health.constants.js";
import { resolveFinalDoctorHealthContributions } from "../flows/doctor-health-contributions-final.js";
import * as gatewayCall from "../gateway/call.js";
import { resolveLeastPrivilegeOperatorScopesForMethod } from "../gateway/method-scopes.js";
import { createGatewayMethodRegistry } from "../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlers,
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
  handlers: GatewayRequestHandlers,
  run: () => Promise<T>,
  methods: string[] = [],
) {
  const registry = createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: resolveLeastPrivilegeOperatorScopesForMethod(name)[0]!,
    })),
  );
  const context = {
    trackExecution: trackAsyncWork,
    deps: {},
    getRuntimeConfig: () => ({}),
    getGatewayMethodRegistry: () => registry,
    logGateway: { warn: vi.fn(), error: vi.fn() },
  } as unknown as GatewayRequestContext;
  const result = await withPluginRuntimeGatewayContextResolver(() => context, run);
  expect(socketCall.mock.calls.map(([request]) => request.method)).toEqual(methods);
  return result;
}

describe("Doctor hosted Gateway reads", () => {
  beforeEach(() => {
    socketCall.mockReset().mockRejectedValue(new Error("unexpected Gateway socket"));
    // Hosted routing and readiness stay real; only socket requests are replaced.
    vi.spyOn(gatewayCall, "callGateway").mockImplementation(socketCall);
    note.mockReset();
    collectWhatsappResponsivenessHealthFindings.mockReset().mockReturnValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("reads exporter diagnostics locally while retaining the wire health probes", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    socketCall.mockImplementation(async ({ method }) => {
      if (method === "status" || method === "channels.status") {
        return {};
      }
      throw new Error("unexpected Gateway socket");
    });
    const result = await withHosted(
      {
        "diagnostics.stability": ({ respond }) =>
          respond(true, {
            events: [
              {
                type: "telemetry.exporter",
                source: "diagnostics-otel",
                target: "logs",
                transport: "stdout",
                outcome: "started",
              },
            ],
          }),
      },
      () => checkGatewayHealth({ runtime, cfg: {} }),
      ["status", "channels.status"],
    );
    expect(result).toMatchObject({ healthOk: true, authenticated: true });
    expect(note).toHaveBeenCalledWith(
      "diagnostics-otel · logs · started · stdout",
      "Telemetry exporters",
    );
    expect(socketCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ timeoutMs: DEFAULT_RESTART_HEALTH_TIMEOUT_MS }),
    );
  });

  it("reads cached memory readiness without opening a Gateway socket", async () => {
    const result = await withHosted(
      {
        "doctor.memory.status": ({ params, respond }) => {
          expect(params.probe).toBe(false);
          respond(true, { embedding: { ok: true } });
        },
      },
      () => probeGatewayMemoryStatus({ cfg: {} }),
    );
    expect(result).toMatchObject({ checked: true, ready: true });
  });

  it("reports hosted pairing inventory without reconnecting or falling back to disk", async () => {
    const result = await withHosted(
      {
        "device.pair.list": ({ respond }) =>
          respond(true, {
            pending: [
              {
                deviceId: "doctor-device",
                requestId: "doctor-request",
                role: "operator",
                scopes: ["operator.read"],
              },
            ],
            paired: [],
          }),
      },
      () => collectDevicePairingHealthFindings({ cfg: {}, healthOk: true }),
    );
    expect(result).toContainEqual(
      expect.objectContaining({
        target: "doctor-device:doctor-request",
        requirement: "first-time",
      }),
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
    await expect(
      withHosted({ status: ({ respond }) => respond(true, status) }, async () =>
        check!.detect({ mode: "doctor", runtime, cfg: {} }),
      ),
    ).resolves.toEqual([]);
    expect(collectWhatsappResponsivenessHealthFindings).toHaveBeenCalledWith({ cfg: {}, status });
  });
});
