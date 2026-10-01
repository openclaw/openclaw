import { describe, expect, it, vi } from "vitest";
import { validateModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import {
  authorizeOperatorScopesForMethod,
  projectOperatorScopesForMethod,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "../method-scopes.js";
import { publishOperatorRoleConfigChange } from "../operator-role-policy.js";
import { captureModelsCliCompatibilityRefresh } from "./models-compatibility-refresh.js";
import { modelsHandlers } from "./models.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

const manualParams = { refresh: true, refreshCliCompatibility: true };

function createRequest(scopes: string[], params: Record<string, unknown> = manualParams) {
  const client: GatewayClient = {
    connId: "manual-model-refresh",
    connect: {
      role: "operator",
      scopes,
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", mode: "test", platform: "test", version: "1" },
    },
  };
  const options: GatewayRequestHandlerOptions = {
    client,
    req: { type: "req", id: "manual-model-refresh", method: "models.list", params },
    params,
    respond: vi.fn(),
    isWebchatConnect: () => false,
    context: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
  };
  return options;
}

describe("manual model CLI compatibility refresh", () => {
  it.each([
    { refreshCliCompatibility: true },
    { ...manualParams, refresh: false },
    { ...manualParams, preparedOnly: true },
    { ...manualParams, sessionKey: "agent:main:main" },
    { ...manualParams, authProfileId: "claude-cli:work" },
  ])("rejects a manual intent without an unscoped refresh: %j", async (params) => {
    const options = createRequest(["operator.write"], params);
    await modelsHandlers["models.list"]!(options);
    expect(options.respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("keeps ordinary and scoped catalog refreshes readable without granting manual maintenance", () => {
    for (const params of [{ refresh: true }, { refresh: true, sessionKey: "agent:main:main" }]) {
      expect(validateModelsListParams(params)).toBe(true);
      expect(resolveLeastPrivilegeOperatorScopesForMethod("models.list", params)).toEqual([
        "operator.read",
      ]);
      expect(authorizeOperatorScopesForMethod("models.list", ["operator.read"], params)).toEqual({
        allowed: true,
      });
    }
    expect(validateModelsListParams(manualParams)).toBe(true);
    expect(resolveLeastPrivilegeOperatorScopesForMethod("models.list", manualParams)).toEqual([
      "operator.write",
    ]);
    expect(
      projectOperatorScopesForMethod({
        method: "models.list",
        requestParams: manualParams,
        requestedScopes: ["operator.write"],
        allowedScopes: ["operator.write"],
      }),
    ).toEqual(["operator.write"]);
  });

  it.each(["operator.read", "operator.sessions.write", "operator.sessions.read"])(
    "rejects manual maintenance through both dispatch and direct handler with %j",
    async (scope) => {
      const scopes = [scope];
      expect(authorizeOperatorScopesForMethod("models.list", scopes, manualParams)).toEqual({
        allowed: false,
        missingScope: "operator.write",
      });
      const options = createRequest(scopes);
      await modelsHandlers["models.list"]!(options);
      expect(options.respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          message: expect.stringContaining("operator.write"),
        }),
      );
    },
  );

  it.each(["operator.write", "operator.admin"])(
    "retains current %s authority only for this request",
    (scope) => {
      const options = createRequest([scope]);
      let current = true;
      options.hasCurrentClientAuthority = () => current;
      const refresh = captureModelsCliCompatibilityRefresh(options);
      try {
        expect(() => refresh.assertCurrent()).not.toThrow();
        current = false;
        expect(() => refresh.assertCurrent()).toThrow("Gateway requester authority changed");
      } finally {
        refresh.release();
      }
    },
  );

  it("rejects captured write authority after the connection loses that grant", () => {
    const options = createRequest(["operator.write"]);
    const refresh = captureModelsCliCompatibilityRefresh(options);
    try {
      options.client!.connect.scopes = ["operator.read"];
      expect(() => refresh.assertCurrent()).toThrow("Gateway requester authority changed");
    } finally {
      refresh.release();
    }
  });

  it("rejects captured maintenance after request cancellation", () => {
    const options = createRequest(["operator.write"]);
    const controller = new AbortController();
    options.signal = controller.signal;
    const refresh = captureModelsCliCompatibilityRefresh(options);
    try {
      controller.abort(new Error("Manual request cancelled"));
      expect(() => refresh.assertCurrent()).toThrow("Manual request cancelled");
    } finally {
      refresh.release();
    }
  });

  it.each(["device", "policy"])(
    "cancels in-flight maintenance on its %s revocation event",
    async (kind) => {
      const options = createRequest(["operator.write"]);
      const captured = captureGatewayDeviceRevocation(
        options.context,
        { deviceId: "maintenance-device", role: "operator" },
        () => true,
      );
      options.hasCurrentClientAuthority = captured.isCurrent;
      const refresh = captureModelsCliCompatibilityRefresh(options);
      const release = createDeferred();
      let updated = false;
      const update = racePromiseWithAbortSignal(release.promise, refresh.signal).then(() => {
        updated = true;
      });
      const outcome = update.then(
        () => "completed",
        (error: unknown) => error,
      );
      try {
        if (kind === "device") {
          invalidateGatewayDeviceRevocation(options.context, "other-device");
          expect(refresh.signal?.aborted).toBe(false);
          invalidateGatewayDeviceRevocation(options.context, "maintenance-device");
        } else {
          options.client!.connect.scopes = ["operator.read"];
          publishOperatorRoleConfigChange({});
          expect(refresh.signal?.aborted).toBe(false);
          publishOperatorRoleConfigChange(options.context);
        }
        expect(refresh.signal?.aborted).toBe(true);
        expect(await outcome).toMatchObject({ name: "AbortError" });
        expect(updated).toBe(false);
      } finally {
        release.resolve();
        await outcome;
        refresh.release();
        captured.release();
      }
    },
  );

  it("releases revocation subscriptions when manual request work is finished", () => {
    const options = createRequest(["operator.write"]);
    const captured = captureGatewayDeviceRevocation(
      options.context,
      { deviceId: "released-device" },
      () => true,
    );
    options.hasCurrentClientAuthority = captured.isCurrent;
    const guard = vi.fn();
    options.sessionMutationCommitGuard = guard;
    const refresh = captureModelsCliCompatibilityRefresh(options);
    try {
      refresh.release();
      expect(refresh.signal?.aborted).toBe(true);
      expect(() => refresh.assertCurrent()).toThrow("Manual CLI compatibility request finished");
      const calls = guard.mock.calls.length;
      options.client!.connect.scopes = ["operator.read"];
      publishOperatorRoleConfigChange(options.context);
      invalidateGatewayDeviceRevocation(options.context, "released-device");
      expect(guard).toHaveBeenCalledTimes(calls);
    } finally {
      refresh.release();
      captured.release();
    }
  });
});
