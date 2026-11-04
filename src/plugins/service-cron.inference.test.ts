import { describe, expect, it, vi } from "vitest";
import { captureCronCreatedInference } from "../gateway/cron-inference-capture.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginRuntimeCapabilityLease } from "./capability-lease.js";
import { createPluginServiceCronGetter } from "./service-cron.js";
import { createServiceCronHost } from "./services.test-support.js";

vi.mock("../gateway/cron-inference-capture.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/cron-inference-capture.js")>()),
  captureCronCreatedInference: vi.fn(),
}));

const job = {
  name: "Service inference",
  description: "Synthetic service account regression",
  enabled: false,
  schedule: { kind: "cron" as const, expr: "0 2 * * *" },
  wakeMode: "next-heartbeat",
  sessionTarget: "isolated" as const,
  payload: { kind: "agentTurn" as const, message: "Run" },
  delivery: { mode: "none" as const },
};

function fixture() {
  const lease = createPluginRuntimeCapabilityLease("test service");
  const cron = createServiceCronHost();
  let current = cron;
  let stopping = false;
  const cfg = {};
  const context = { getRuntimeConfig: () => cfg } as GatewayRequestContext;
  const capture = {
    inferenceBinding: {
      version: 1 as const,
      provider: "openai",
      profileId: "openai:test",
      authorizationId: "test-authorization",
      authRequirement: "api-key" as const,
      runtime: "openclaw",
      source: "auto" as const,
    },
    assertInferenceSelectionCurrent: vi.fn(),
    disposeInferenceAuthorization: vi.fn(),
  };
  vi.mocked(captureCronCreatedInference).mockReset().mockResolvedValue(capture);
  const get = createPluginServiceCronGetter({
    pluginId: "test",
    lease,
    getCron: () => current,
    isStopping: () => stopping,
    resolveGatewayContext: () => context,
  });
  const service = get()!;
  return {
    cron,
    capture,
    service,
    cfg,
    lease,
    stop: () => {
      stopping = true;
    },
    replace: () => {
      current = createServiceCronHost();
    },
  };
}

describe("service creation inference lifetime", () => {
  it("uses the scheduler's effective agent and retains capture through acceptance", async () => {
    const f = fixture();
    vi.mocked(f.cron.add).mockImplementationOnce(async (_job, options) => {
      expect(f.capture.disposeInferenceAuthorization).not.toHaveBeenCalled();
      options?.commitGuard?.();
      throw new Error("store rejection");
    });
    const input = { ...job, sessionKey: "agent:secondary:source" };
    await expect(f.service.add(input)).rejects.toThrow("store rejection");
    expect(captureCronCreatedInference).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: f.cfg,
        agentId: "secondary",
        caller: expect.objectContaining({ client: null }),
      }),
    );
    expect(f.capture.assertInferenceSelectionCurrent).toHaveBeenCalledOnce();
    expect(f.capture.disposeInferenceAuthorization).toHaveBeenCalledOnce();
  });

  it.for(["stop", "replace", "revoke", "credential"] as const)(
    "refuses %s after asynchronous capture and releases authorization",
    async (kind) => {
      const f = fixture();
      const captured = createDeferredCore<typeof f.capture>();
      vi.mocked(captureCronCreatedInference).mockReturnValueOnce(captured.promise);
      vi.mocked(f.cron.add).mockImplementationOnce(async (_job, options) => {
        options?.commitGuard?.();
        throw new Error("unexpected accepted write");
      });
      const pending = f.service.add(job);
      if (kind === "stop") {
        f.stop();
      }
      if (kind === "replace") {
        f.replace();
      }
      if (kind === "revoke") {
        f.lease.revoke();
      }
      if (kind === "credential") {
        f.capture.assertInferenceSelectionCurrent.mockImplementation(() => {
          throw new Error("credential replaced");
        });
      }
      const rejected = expect(pending).rejects.toThrow(
        kind === "stop"
          ? "stopping"
          : kind === "replace"
            ? "scheduler was replaced"
            : kind === "revoke"
              ? "no longer active"
              : "credential replaced",
      );
      captured.resolve(f.capture);
      await rejected;
      expect(f.capture.disposeInferenceAuthorization).toHaveBeenCalledOnce();
    },
  );

  it("pins the captured default agent across a reload before store acceptance", async () => {
    const f = fixture();
    vi.mocked(f.cron.getDefaultAgentId).mockReturnValue("first");
    const captured = createDeferredCore<typeof f.capture>();
    vi.mocked(captureCronCreatedInference).mockReturnValueOnce(captured.promise);
    vi.mocked(f.cron.add).mockImplementationOnce(async (accepted, options) => {
      options?.commitGuard?.();
      expect(accepted.agentId).toBe("first");
      throw new Error("observed pinned owner");
    });
    const pending = f.service.add(job);
    const rejected = expect(pending).rejects.toThrow("observed pinned owner");
    vi.mocked(f.cron.getDefaultAgentId).mockReturnValue("second");
    captured.resolve(f.capture);
    await rejected;
    expect(captureCronCreatedInference).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "first" }),
    );
    expect(f.capture.disposeInferenceAuthorization).toHaveBeenCalledOnce();
  });

  it("releases capture after successful settlement", async () => {
    const f = fixture();
    vi.mocked(f.cron.add).mockImplementationOnce(async (_job, options) => {
      options?.commitGuard?.();
      expect(f.capture.disposeInferenceAuthorization).not.toHaveBeenCalled();
      return { ...job, id: "accepted" } as Awaited<ReturnType<typeof f.cron.add>>;
    });
    await f.service.add(job);
    expect(f.capture.disposeInferenceAuthorization).toHaveBeenCalledOnce();
  });
});
