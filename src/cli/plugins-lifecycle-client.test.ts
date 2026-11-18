import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../packages/gateway-client/src/pending-request.js";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import { buildCapabilityConsentErrorDetails } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { assertTemplatesLabsEnabled, TemplatesLabsDisabledError } from "../templates/labs-gate.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import type { PluginLifecycleGateway } from "./plugins-lifecycle-client.js";
import { waitForSignalExitBarriers } from "./signal-exit-barrier.js";

const mocks = vi.hoisted(() => ({ lock: vi.fn(), call: vi.fn() }));
vi.mock("../infra/gateway-lock.js", () => ({ readActiveGatewayLockIdentity: mocks.lock }));
vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: mocks.call,
}));
const { resolvePluginLifecycleGateway, resolvePluginBatchReload } =
  await import("./plugins-lifecycle-client.js");

const targets = [{ pluginId: "demo", installHash: "a".repeat(64) }];
const runtimeReceipt = { operationId: "batch", generation: 2, pluginIds: ["demo"] };
const applied = { runtime: { generation: 3 } };
const reloadParams = { plugins: [{ pluginId: "demo" }], waitForDrain: true };
const captureError = (error: unknown) => error;
const consentRequired = (pluginId: string, reviewToken: string) =>
  Object.assign(new Error(`${pluginId} consent required`), {
    details: buildCapabilityConsentErrorDetails({ pluginId, reviewToken }),
  });
const inspection = (id: string, reviewToken?: string) => ({ plugin: { id }, reviewToken });
async function dispatch(...args: Parameters<PluginLifecycleGateway>) {
  const gateway = await resolvePluginLifecycleGateway();
  return gateway!(...args);
}

async function createPluginRefusalResponse(retryAfterMs = 1_000) {
  const pending = new GatewayPendingRequests({
    createRequestId: () => "plugin-refusal",
    nowMs: Date.now,
    createRequestError: (error) => new GatewayClientRequestError(error),
  });
  let requestId = "";
  const response = pending.request(
    {
      send: (data) => {
        const frame: unknown = JSON.parse(data);
        if (!isRecord(frame) || typeof frame.id !== "string") {
          throw new Error("Gateway request omitted its ID");
        }
        requestId = frame.id;
      },
    },
    "plugins.setEnabled",
  );
  pending.handleResponse({
    type: "res",
    id: requestId,
    ok: false,
    error: {
      code: "UNAVAILABLE",
      message: "plugin lifecycle busy",
      retryable: true,
      retryAfterMs,
      details: { mutationAccepted: false },
    },
  });
  return await response.catch(captureError);
}

describe("plugin lifecycle CLI transport", () => {
  beforeEach(() => {
    mocks.lock.mockReset().mockResolvedValue({ port: 19001 });
    mocks.call.mockReset().mockResolvedValue({ runtime: { generation: 2 } });
  });
  afterEach(() => vi.useRealTimers());

  it("waits without a response deadline and cancels the request on CLI interruption", async () => {
    let observed: AbortSignal | undefined;
    const interrupted = new Error("request interrupted");
    const entered = Promise.withResolvers<void>();
    mocks.call.mockImplementation(({ signal, timeoutMs }) => {
      observed = signal;
      entered.resolve();
      expect(timeoutMs).toBeNull();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(interrupted), { once: true });
      });
    });
    const request = dispatch("plugins.reload", reloadParams).catch(captureError);
    await entered.promise;
    expect(observed).toBeInstanceOf(AbortSignal);
    await waitForSignalExitBarriers();
    expect(observed?.aborted).toBe(true);
    expect(await request).toBe(interrupted);
    expect(mocks.call).toHaveBeenCalledOnce();
  });

  it("keeps lifecycle admission bounded even when admitted drain may wait indefinitely", async () => {
    const busy = await createPluginRefusalResponse(600_000);
    mocks.call.mockRejectedValue(busy);
    await expect(dispatch("plugins.reload", reloadParams)).rejects.toBe(busy);
    expect(mocks.call).toHaveBeenCalledOnce();
    await expect(waitForSignalExitBarriers()).resolves.toBeUndefined();
  });

  it("finishes a plugin mutation after an explicit pre-admission refusal", async () => {
    vi.useFakeTimers();
    const afterContention = { runtime: { operationId: "after-contention", generation: 3 } };
    mocks.call
      .mockRejectedValueOnce(await createPluginRefusalResponse())
      .mockResolvedValueOnce(afterContention);
    const outcome = dispatch("plugins.setEnabled", { pluginId: "demo", enabled: false }).catch(
      captureError,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toEqual(afterContention);
    expect(mocks.call).toHaveBeenCalledTimes(2);
  });

  it.each([
    { method: "plugins.reload", params: reloadParams },
    { method: "plugins.setEnabled", params: { pluginId: "demo", enabled: false } },
  ])("cancels an unaccepted $method retry before another dispatch", async ({ method, params }) => {
    vi.useFakeTimers();
    mocks.call
      .mockRejectedValueOnce(await createPluginRefusalResponse())
      .mockResolvedValueOnce(applied);
    let settled = false;
    const outcome = dispatch(method, params)
      .catch(captureError)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await waitForSignalExitBarriers();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(mocks.call).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("selects offline execution only when no local owner exists", async () => {
    mocks.lock.mockResolvedValue(null);
    expect(await resolvePluginLifecycleGateway()).toBeNull();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "requires an actual batch application receipt (present=%s)",
    async (present) => {
      const runtime = runtimeReceipt;
      const warnings = ["Previous plugin cleanup did not finish."];
      mocks.call.mockResolvedValue(present ? { runtime, warnings, restartRequired: true } : {});
      const reload = await resolvePluginBatchReload();
      expect(reload).toBeDefined();
      if (present) {
        await expect(reload!(targets)).resolves.toEqual({
          ...runtime,
          warnings,
          restartRequired: true,
        });
      } else {
        await expect(reload!(targets)).rejects.toThrow("did not confirm");
      }
      expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ method: "plugins.reload", params: { plugins: targets } }),
      );
    },
  );

  it("rechecks Labs after a pending plugin batch reload response", async () => {
    const reply = Promise.withResolvers<{ runtime: typeof runtimeReceipt }>();
    mocks.call.mockReturnValue(reply.promise);
    let labsEnabled = true;
    const commitGuard = vi.fn(() =>
      assertTemplatesLabsEnabled({
        gateway: { controlUi: { experimental: { templates: labsEnabled } } },
      }),
    );
    const reload = await resolvePluginBatchReload();
    const result = reload!(targets, { commitGuard });

    expect(mocks.call).toHaveBeenCalledOnce();
    expect(commitGuard).not.toHaveBeenCalled();
    labsEnabled = false;
    reply.resolve({ runtime: runtimeReceipt });

    await expect(result).rejects.toBeInstanceOf(TemplatesLabsDisabledError);
    expect(commitGuard).toHaveBeenCalledOnce();
  });

  it("does not select offline mutation when an existing owner cannot be inspected", async () => {
    const { readActiveGatewayLockIdentity, GatewayLockError } = await vi.importActual<
      typeof import("../infra/gateway-lock.js")
    >("../infra/gateway-lock.js");
    await withTestDir({ prefix: "plugin-lifecycle-owner-" }, async (dir) => {
      await fs.writeFile(path.join(dir, "gateway.state.lock"), "{");
      mocks.lock.mockImplementation((options) =>
        readActiveGatewayLockIdentity({
          ...options,
          env: { OPENCLAW_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: path.join(dir, "openclaw.json") },
          lockDir: dir,
        }),
      );
      await expect(resolvePluginLifecycleGateway()).rejects.toBeInstanceOf(GatewayLockError);
      expect(mocks.call).not.toHaveBeenCalled();
    });
  });

  it.each(["lost-reply", "missing-admission-fact", "admitted", "unmarked-refusal"])(
    "does not replay an uncertain plugin mutation (%s)",
    async (outcome) => {
      vi.useFakeTimers();
      const failure =
        outcome === "lost-reply"
          ? new Error("connection lost")
          : new GatewayClientRequestError({
              code: "UNAVAILABLE",
              message: "plugin operation unavailable",
              retryable: true,
              retryAfterMs: 1_000,
              ...(outcome === "admitted" || outcome === "unmarked-refusal"
                ? { details: { mutationAccepted: outcome === "admitted" } }
                : {}),
            });
      mocks.call.mockRejectedValueOnce(failure).mockResolvedValueOnce(applied);
      const result = dispatch("plugins.uninstall", { pluginId: "demo" }).catch(captureError);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toBe(failure);
      expect(mocks.call).toHaveBeenCalledOnce();
    },
  );

  it("retries reload consent using the inspected artifact's exact token", async () => {
    const method = "plugins.reload";
    const params = { plugins: [{ pluginId: "demo" }] };
    const oldToken = "a".repeat(64);
    const currentToken = "b".repeat(64);
    mocks.call
      .mockRejectedValueOnce(consentRequired("demo", oldToken))
      .mockResolvedValueOnce(inspection("demo", currentToken))
      .mockResolvedValueOnce(applied);
    const consent = vi.fn(async (review: { reviewToken: string }) => ({
      reviewToken: review.reviewToken,
    }));
    await dispatch(method, params, consent);
    expect(consent).toHaveBeenCalledWith(expect.objectContaining({ reviewToken: currentToken }));
    expect(mocks.call).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method,
        params: { ...params, acknowledgeCapabilities: { reviewToken: currentToken } },
      }),
    );
  });

  it("refuses capability consent when inspection has no artifact review token", async () => {
    mocks.call
      .mockRejectedValueOnce(consentRequired("demo", "a".repeat(64)))
      .mockResolvedValueOnce(inspection("demo"));
    const consent = vi.fn();
    await expect(
      dispatch("plugins.setEnabled", { pluginId: "demo", enabled: true }, consent),
    ).rejects.toThrow("Gateway did not return a capability-consent token");
    expect(consent).not.toHaveBeenCalled();
    expect(mocks.call).toHaveBeenCalledTimes(2);
  });

  it.each(["accepted", "declined", "rejected-again", "connection-lost"])(
    "reviews successive batch capabilities without repeating uncertain mutations (%s)",
    async (outcome) => {
      const firstToken = "a".repeat(64);
      const secondToken = "b".repeat(64);
      const secondFailure = consentRequired("beta", secondToken);
      const finalFailure =
        outcome === "connection-lost" ? new Error("connection lost") : secondFailure;
      mocks.call
        .mockRejectedValueOnce(consentRequired("alpha", firstToken))
        .mockResolvedValueOnce(inspection("alpha", firstToken))
        .mockRejectedValueOnce(secondFailure)
        .mockResolvedValueOnce(inspection("beta", secondToken));
      if (outcome === "accepted") {
        mocks.call.mockResolvedValueOnce(applied);
      } else {
        mocks.call.mockRejectedValueOnce(finalFailure);
      }
      const consent = vi.fn(async (review: { pluginId: string; reviewToken: string }) =>
        outcome === "declined" && review.pluginId === "beta"
          ? undefined
          : { reviewToken: review.reviewToken },
      );
      const params = { plugins: [{ pluginId: "alpha" }, { pluginId: "beta" }] };
      const reload = dispatch("plugins.reload", params, consent);
      if (outcome === "accepted") {
        await expect(reload).resolves.toEqual({ runtime: { generation: 3 } });
      } else {
        await expect(reload).rejects.toBe(finalFailure);
      }
      expect(consent.mock.calls.map(([review]) => review.pluginId)).toEqual(["alpha", "beta"]);
      expect(
        mocks.call.mock.calls
          .filter(([call]) => call.method === "plugins.reload")
          .map(([call]) => call.params),
      ).toEqual([
        params,
        { ...params, acknowledgeCapabilities: { reviewToken: firstToken } },
        ...(outcome === "declined"
          ? []
          : [{ ...params, acknowledgeCapabilities: { reviewToken: secondToken } }]),
      ]);
    },
  );
});
