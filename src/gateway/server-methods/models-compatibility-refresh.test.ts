import { describe, expect, it, vi } from "vitest";
import { validateModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as deviceRevocation from "../device-revocation.js";
import {
  authorizeOperatorScopesForMethod,
  projectOperatorScopesForMethod,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "../method-scopes.js";
import * as operatorRolePolicy from "../operator-role-policy.js";
import {
  readPreparedCatalog,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { captureModelsCliCompatibilityRefresh } from "./models-compatibility-refresh.js";
import {
  createModelsListTestContext,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";
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

  it.each(["success", "failure"] as const)(
    "retains manual authority through prepared execution and releases it after %s",
    async (outcome) => {
      await withOpenClawTestState({ label: "manual-cli-prepared-read" }, async (state) => {
        const options = createRequest(["operator.write"], {
          ...manualParams,
          agentId: "main",
          view: "all",
          includeDefaultModels: false,
        });
        const context = createModelsListTestContext({
          cfg: { agents: { entries: { main: {} } } },
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          catalog: [providerCatalogEntry("fixture", "ready")],
          catalogComplete: true,
        });
        options.context = context;
        const snapshot = (await readPreparedCatalog(context, "main"))!;
        let refresh: { assertCurrent: () => void; signal?: AbortSignal } | undefined;
        let maintenanceCompleted = false;
        registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
          readPrepared: async () => snapshot,
          loadDeferred: async (params) => {
            refresh = params?.cliCompatibilityRefresh;
            expect(refresh).toBeDefined();
            refresh!.assertCurrent();
            await Promise.resolve();
            refresh!.assertCurrent();
            expect(refresh!.signal?.aborted).toBe(false);
            if (outcome === "failure") {
              throw new Error("Fixture installer failed");
            }
            maintenanceCompleted = true;
            return snapshot;
          },
        });
        // The real handler prepares and later consumes its reader. Maintenance must
        // remain authorized between those phases and settle before request cleanup.
        if (outcome === "failure") {
          await expect(modelsHandlers["models.list"]!(options)).rejects.toThrow(
            "Fixture installer failed",
          );
          expect(options.respond).not.toHaveBeenCalled();
        } else {
          await modelsHandlers["models.list"]!(options);
          expect(options.respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              models: [expect.objectContaining({ provider: "fixture", id: "ready" })],
            }),
            undefined,
          );
        }
        expect(maintenanceCompleted).toBe(outcome === "success");
        expect(refresh?.signal?.aborted).toBe(true);
        expect(() => refresh!.assertCurrent()).toThrow("Manual CLI compatibility request finished");
      });
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
      const captured = deviceRevocation.captureGatewayDeviceRevocation(
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
          deviceRevocation.invalidateGatewayDeviceRevocation(options.context, "other-device");
          expect(refresh.signal?.aborted).toBe(false);
          deviceRevocation.invalidateGatewayDeviceRevocation(options.context, "maintenance-device");
        } else {
          options.client!.connect.scopes = ["operator.read"];
          operatorRolePolicy.publishOperatorRoleConfigChange({});
          expect(refresh.signal?.aborted).toBe(false);
          operatorRolePolicy.publishOperatorRoleConfigChange(options.context);
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
    const captured = deviceRevocation.captureGatewayDeviceRevocation(
      options.context,
      { deviceId: "released-device" },
      () => true,
    );
    options.hasCurrentClientAuthority = captured.isCurrent;
    const subscribeDevice = deviceRevocation.onGatewayDeviceSourceRevoked;
    const subscribePolicy = operatorRolePolicy.onOperatorRolePolicyChanged;
    const deviceEvent = vi.fn();
    const policyEvent = vi.fn();
    const subscriptions: Array<() => void> = [];
    const deviceSubscription = vi
      .spyOn(deviceRevocation, "onGatewayDeviceSourceRevoked")
      .mockImplementation((guard, listener) => {
        const unsubscribe = subscribeDevice(guard, () => {
          deviceEvent();
          listener();
        });
        if (unsubscribe) {
          subscriptions.push(unsubscribe);
        }
        return unsubscribe;
      });
    const policySubscription = vi
      .spyOn(operatorRolePolicy, "onOperatorRolePolicyChanged")
      .mockImplementation((listener) => {
        const unsubscribe = subscribePolicy((change) => {
          policyEvent();
          listener(change);
        });
        subscriptions.push(unsubscribe);
        return unsubscribe;
      });
    let refresh: ReturnType<typeof captureModelsCliCompatibilityRefresh> | undefined;
    try {
      refresh = captureModelsCliCompatibilityRefresh(options);
      expect(subscriptions).toHaveLength(2);
      operatorRolePolicy.publishOperatorRoleConfigChange(options.context);
      expect(policyEvent).toHaveBeenCalledOnce();
      expect(refresh.signal.aborted).toBe(false);
      policyEvent.mockClear();
      refresh.release();
      expect(refresh.signal.aborted).toBe(true);
      expect(() => refresh!.assertCurrent()).toThrow("Manual CLI compatibility request finished");
      options.client!.connect.scopes = ["operator.read"];
      operatorRolePolicy.publishOperatorRoleConfigChange(options.context);
      deviceRevocation.invalidateGatewayDeviceRevocation(options.context, "released-device");
      expect(policyEvent).not.toHaveBeenCalled();
      expect(deviceEvent).not.toHaveBeenCalled();
    } finally {
      refresh?.release();
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      captured.release();
      deviceSubscription.mockRestore();
      policySubscription.mockRestore();
    }
  });
});
