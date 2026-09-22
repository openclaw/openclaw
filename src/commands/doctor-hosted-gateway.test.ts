import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreHealthChecks } from "../flows/doctor-core-checks.js";
import { resolveFinalDoctorHealthContributions } from "../flows/doctor-health-contributions-final.js";
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

const {
  socketCall,
  note,
  collectClawStateHealthFindings,
  collectWhatsappResponsivenessHealthFindings,
} = vi.hoisted(() => ({
  socketCall: vi.fn(),
  note: vi.fn(),
  collectClawStateHealthFindings: vi.fn(),
  collectWhatsappResponsivenessHealthFindings: vi.fn(),
}));
vi.mock("../gateway/call.js", () => ({ callGateway: socketCall }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
vi.mock("../claws/doctor.js", () => ({ collectClawStateHealthFindings }));
vi.mock("./doctor-whatsapp-responsiveness.js", () => ({
  collectWhatsappResponsivenessHealthFindings,
}));

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

function contextFor(handlers: GatewayRequestHandlers): GatewayRequestContext {
  const registry = createGatewayMethodRegistry(
    Object.entries(handlers).map(([name, handler]) => ({
      name,
      handler,
      owner: { kind: "core" as const, area: "test" },
      scope: resolveLeastPrivilegeOperatorScopesForMethod(name)[0]!,
    })),
  );
  return {
    trackExecution: trackAsyncWork,
    deps: {},
    getRuntimeConfig: () => ({}),
    getGatewayMethodRegistry: () => registry,
    logGateway: { warn: vi.fn(), error: vi.fn() },
  } as unknown as GatewayRequestContext;
}

describe("Doctor hosted Gateway reads", () => {
  beforeEach(() => {
    socketCall.mockReset().mockRejectedValue(new Error("unexpected Gateway socket"));
    note.mockReset();
    collectClawStateHealthFindings.mockReset();
    collectWhatsappResponsivenessHealthFindings.mockReset().mockReturnValue([]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reads exporter diagnostics locally while retaining the wire health probes", async () => {
    socketCall.mockImplementation(async ({ method }) => {
      if (method === "status" || method === "channels.status") {
        return {};
      }
      throw new Error("unexpected Gateway socket");
    });
    const context = contextFor({
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
    });
    await withPluginRuntimeGatewayContextResolver(
      () => context,
      () => checkGatewayHealth({ runtime, cfg: {} }),
    );
    expect(note).toHaveBeenCalledWith(
      "diagnostics-otel · logs · started · stdout",
      "Telemetry exporters",
    );
    expect(socketCall.mock.calls.map(([request]) => request.method)).toEqual([
      "status",
      "channels.status",
    ]);
  });

  it("reads cached memory readiness without opening a Gateway socket", async () => {
    const context = contextFor({
      "doctor.memory.status": ({ params, respond }) => {
        expect(params.probe).toBe(false);
        respond(true, { embedding: { ok: true } });
      },
    });
    await withPluginRuntimeGatewayContextResolver(
      () => context,
      async () => {
        await expect(probeGatewayMemoryStatus({ cfg: {} })).resolves.toMatchObject({
          checked: true,
          ready: true,
        });
      },
    );
    expect(socketCall).not.toHaveBeenCalled();
  });

  it("keeps paginated cron inventory bound to the original hosted Gateway", async () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    let reads = 0;
    let current: GatewayRequestContext | undefined = contextFor({
      "cron.list": ({ params, respond }) => {
        reads += 1;
        expect(params.offset).toBe(0);
        respond(true, {
          jobs: [{ id: "first" }],
          snapshotRevision: "revision",
          total: 2,
          offset: 0,
          limit: 200,
          hasMore: true,
          nextOffset: 1,
        });
        current = contextFor({
          "cron.list": () => {
            throw new Error("replacement Gateway used");
          },
        });
      },
    });
    collectClawStateHealthFindings.mockImplementation(
      async ({ cronGateway }) => await cronGateway.list(),
    );
    const check = createCoreHealthChecks().find((entry) => entry.id === "core/doctor/claws-state");
    expect(check).toBeDefined();
    await withPluginRuntimeGatewayContextResolver(
      () => current,
      async () => {
        await expect(check!.detect({ mode: "doctor", runtime, cfg: {} })).rejects.toThrow(
          "Gateway instance unavailable",
        );
      },
    );
    expect(reads).toBe(1);
    expect(socketCall).not.toHaveBeenCalled();
  });

  it("reports hosted pairing inventory without reconnecting or falling back to disk", async () => {
    const context = contextFor({
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
    });
    await withPluginRuntimeGatewayContextResolver(
      () => context,
      async () => {
        await expect(
          collectDevicePairingHealthFindings({ cfg: {}, healthOk: true }),
        ).resolves.toContainEqual(
          expect.objectContaining({
            target: "doctor-device:doctor-request",
            requirement: "first-time",
          }),
        );
      },
    );
    expect(socketCall).not.toHaveBeenCalled();
  });

  it("passes hosted pressure data to the optional WhatsApp check without reconnecting", async () => {
    const status = { eventLoop: { degraded: true } };
    const context = contextFor({ status: ({ respond }) => respond(true, status) });
    const contributions = resolveFinalDoctorHealthContributions({
      runSystemdLingerHealth: async () => {},
      detectSystemdLingerFindings: async () => [],
      runShellCompletionHealth: async () => {},
      runGatewayHealthChecks: async () => {},
    });
    const check = contributions.find((entry) => entry.id === "doctor:whatsapp-responsiveness")
      ?.healthChecks[0];
    expect(check).toBeDefined();
    await withPluginRuntimeGatewayContextResolver(
      () => context,
      async () => {
        await expect(check!.detect({ mode: "doctor", runtime, cfg: {} })).resolves.toEqual([]);
      },
    );
    expect(collectWhatsappResponsivenessHealthFindings).toHaveBeenCalledWith({ cfg: {}, status });
    expect(socketCall).not.toHaveBeenCalled();
  });
});
