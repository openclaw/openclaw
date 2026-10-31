// Plugin management mutation tests cover consent, publication, and cleanup outcomes.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCapabilityConsentErrorDetails,
  type CapabilityConsentErrorDetails,
} from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildPluginCapabilityConsentReview } from "../../plugins/capability-summary.js";
import {
  PluginInstallPersistedError,
  PluginRuntimeApplicationError,
  type PluginLifecycleRuntimeApply,
  type PluginRuntimeApplication,
} from "../../plugins/lifecycle.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import type { installManagedPlugin } from "../../plugins/management-mutations.js";
import { OpenClawStateLeaseAcquisitionError } from "../../state/openclaw-state-lease-error.js";
import type { GatewayRequestHandler, RespondFn } from "./types.js";

const managementMocks = vi.hoisted(() => ({
  install: vi.fn(),
  refreshMetadata: vi.fn(),
  reload: vi.fn(),
  setEnabled: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("../../plugins/management-mutations.js", () => ({
  refreshManagedPlugins: (...args: unknown[]) => managementMocks.refreshMetadata(...args),
  reloadManagedPlugin: (...args: unknown[]) => managementMocks.reload(...args),
  installManagedPlugin: (...args: unknown[]) => managementMocks.install(...args),
  setManagedPluginEnabled: (...args: unknown[]) => managementMocks.setEnabled(...args),
}));

vi.mock("../../plugins/management-uninstall.js", () => ({
  uninstallManagedPlugin: (...args: unknown[]) => managementMocks.uninstall(...args),
}));

const { pluginMutationHandlers } = await import("./plugins-mutations.js");

async function callHandler(
  method: string,
  params: Record<string, unknown>,
  runtimeConfig: Record<string, unknown> = {},
  applyRuntime: PluginLifecycleRuntimeApply = async () => application,
  localClient = false,
  authority: Pick<
    Parameters<GatewayRequestHandler>[0],
    "signal" | "sessionMutationCommitGuard"
  > = {},
) {
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    pluginMutationHandlers[method],
    "pluginMutationHandlers[method] test invariant",
  )({
    ...authority,
    params,
    req: {} as never,
    // Local RPCs carry both admitted administrator authority and host-attested ingress.
    client: (localClient
      ? {
          connect: { role: "operator", scopes: ["operator.admin"] },
          internal: { isLocalClient: true },
        }
      : null) as never,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => runtimeConfig,
      applyPluginLifecycleChange: applyRuntime,
    } as never,
    respond,
  });
  const [ok, response, error] = respond.mock.calls.at(-1) ?? [null, undefined, undefined];
  return { ok, response, error };
}

const application = { operationId: "rpc-test", generation: 1, pluginIds: ["workboard"] };

const workboard = {
  id: "workboard",
  name: "Workboard",
  installed: true,
  enabled: false,
  state: "disabled" as const,
  featured: true,
  order: 10,
};

const reviewToken = "a".repeat(64);

const capabilityConsent = {
  pluginId: "workboard",
  reviewToken,
  widened: { tools: ["workboard_read"] },
  acceptedAt: "2026-08-25T00:00:00.000Z",
} satisfies Omit<CapabilityConsentErrorDetails, "capabilityConsentCode">;

type Result = Awaited<ReturnType<typeof callHandler>>;
function expectResponse(result: Result, response: Record<string, unknown>) {
  expect(result).toEqual({
    ok: true,
    response: { ok: true, restartRequired: false, ...response },
    error: undefined,
  });
}
function expectFailure(result: Result, error: Record<string, unknown>) {
  expect(result).toMatchObject({ ok: false, error });
}
const official = (pluginId = "workboard") => ({ source: "official", pluginId });
const clawhub = (packageName = "community/workboard") => ({ source: "clawhub", packageName });
const activation = { ...application, phase: "activate" as const, committed: false };
const runtimeChange = (reason: "install" | "uninstall" | "reload", pluginId = "workboard") => ({
  config: {},
  pluginIds: [pluginId],
  reason,
});
describe("plugin management Gateway mutation handlers", () => {
  beforeEach(() => {
    for (const mock of Object.values(managementMocks)) {
      mock.mockReset();
    }
  });

  it.each(["completed", "failed"] as const)(
    "targets install activity to its requester (%s)",
    async (status) => {
      const broadcastToConnIds = vi.fn();
      const expectActivity = (nth: number, event: Record<string, unknown>) =>
        expect(broadcastToConnIds).toHaveBeenNthCalledWith(
          nth,
          "plugins.install.progress",
          { ...event, requestId: "install-one" },
          new Set(["owner-connection"]),
        );
      const respond = vi.fn();
      const applying = createDeferred<PluginRuntimeApplication>();
      const enteredRuntime = createDeferred();
      const activity = {
        activityId: "dependency-install",
        stage: "dependencies",
        status: "completed",
      } as const;
      managementMocks.install.mockImplementation(
        async (params: Parameters<typeof installManagedPlugin>[0]) => {
          params.logger?.activity?.(activity);
          return {
            plugin: workboard,
            application: await params.applyRuntime!(runtimeChange("install")),
          };
        },
      );
      const pending = pluginMutationHandlers["plugins.install"]!({
        req: { type: "req", id: "install-one", method: "plugins.install" },
        params: { source: "npm", spec: "workboard" },
        client: {
          connId: "owner-connection",
          connect: { role: "operator", scopes: ["operator.admin"] },
        } as never,
        context: {
          applyPluginLifecycleChange: () => {
            enteredRuntime.resolve();
            return applying.promise;
          },
          broadcastToConnIds,
        } as never,
        isWebchatConnect: () => false,
        respond,
      });
      try {
        await enteredRuntime.promise;
        expectActivity(1, activity);
        expectActivity(2, {
          activityId: expect.any(String),
          stage: "runtime",
          status: "started",
        });
        expect(respond).not.toHaveBeenCalled();
        expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
        if (status === "completed") {
          applying.resolve(application);
        } else {
          applying.reject(new PluginRuntimeApplicationError("Service startup failed", activation));
        }
        await pending;
        expectActivity(3, { ...broadcastToConnIds.mock.calls[1]![1], status });
        expect(broadcastToConnIds).toHaveBeenCalledTimes(3);
        expect(respond.mock.calls[0]?.[0]).toBe(status === "completed");
      } finally {
        applying.resolve(application);
        await pending;
      }
    },
  );

  it.each([
    { source: "local", path: "/tmp/demo.tgz" },
    { source: "npm-pack", archivePath: "/tmp/demo.tgz" },
    { source: "git", spec: "git:file:///tmp/demo.git" },
    { source: "marketplace", marketplace: "/tmp/marketplace", plugin: "demo" },
  ])("requires host-attested ingress for $source", async (request) => {
    managementMocks.install.mockResolvedValue({ plugin: workboard, application });
    expectFailure(await callHandler("plugins.install", request), {
      code: "INVALID_REQUEST",
      message: expect.stringContaining("Gateway host"),
    });
    expect(managementMocks.install).not.toHaveBeenCalled();
    expect(await callHandler("plugins.install", request, {}, undefined, true)).toMatchObject({
      ok: true,
      response: { restartRequired: false, runtime: application },
    });
  });

  it.each(["current", "cancelled", "revoked"] as const)(
    "accepts staged capabilities only for a %s request",
    async (state) => {
      const config = {
        plugins: { entries: { workboard: { hooks: { allowPromptInjection: false } } } },
      };
      const originalConfig = structuredClone(config);
      const review = buildPluginCapabilityConsentReview({
        pluginId: "workboard",
        manifest: { contracts: { tools: ["workboard_read"] } },
        record: { source: "clawhub", clawhubPackage: "community/workboard" },
        config,
      });
      const abort = new AbortController();
      let owned = true;
      managementMocks.install.mockImplementation(
        async (options: Parameters<typeof installManagedPlugin>[0]) => {
          if (state === "cancelled") {
            abort.abort(new Error("Install request cancelled"));
          }
          owned = state !== "revoked";
          const acknowledge = expectDefined(
            options.onCapabilityConsent,
            "staged install acceptance",
          );
          expect(await acknowledge(review)).toEqual({ reviewToken: review.reviewToken });
          return { plugin: workboard, application };
        },
      );
      const result = await callHandler("plugins.install", clawhub(), config, undefined, false, {
        signal: abort.signal,
        sessionMutationCommitGuard: () => {
          if (!owned) {
            throw new Error("Install request owner changed");
          }
        },
      });
      expect(result.ok).toBe(state === "current");
      if (state !== "current") {
        expect(result.error).toHaveProperty(
          "message",
          state === "cancelled" ? "Install request cancelled" : "Install request owner changed",
        );
      }
      expect(config).toEqual(originalConfig);
      expect(review.grants.hooks).toEqual({
        allowPromptInjection: { configured: false, effective: false },
        allowConversationAccess: { effective: false },
      });
    },
  );

  it("returns reload restart requirement and deduplicated warnings", async () => {
    const plugins = [
      {
        pluginId: "workboard",
        installHash: "a".repeat(64),
        sourceDigests: { workboard: "b".repeat(64) },
      },
      { pluginId: "diffs", installHash: "c".repeat(64) },
    ];
    const pluginIds = plugins.map((plugin) => plugin.pluginId);
    const runtime = { ...application, pluginIds };
    const warning = "Previous plugin service could not close.";
    managementMocks.reload.mockResolvedValue({
      pluginIds,
      application: { ...runtime, restartRequired: true, warnings: [warning] },
      warnings: [warning],
    });

    expectResponse(await callHandler("plugins.reload", { plugins }), {
      pluginIds,
      restartRequired: true,
      runtime,
      warnings: [warning],
    });
  });

  it.each([
    { label: "cleanup", error: new Error("file cleanup failed") },
    {
      label: "nested lease",
      error: new OpenClawStateLeaseAcquisitionError("package cleanup lease", {
        kind: "held",
        holder: { owner: "another-package-owner", epoch: 1 },
      }),
    },
  ])("retains publication after a nonretryable $label failure", async ({ error }) => {
    managementMocks.uninstall.mockImplementation(async (options) => {
      await options.applyRuntime(runtimeChange("uninstall"));
      throw error;
    });
    const result = await callHandler("plugins.uninstall", { pluginId: "workboard" });
    expectFailure(result, {
      code: "UNAVAILABLE",
      message: expect.stringContaining(error.message),
      details: { runtime: { ...application, committed: true } },
    });
    expect(result.error).not.toHaveProperty("retryable");
  });

  it.each([false, true])(
    "keeps runtime warnings and final facts (rejectLater=%s)",
    async (rejectLater) => {
      const warning = "Previous plugin cleanup failed.";
      const removed = ["config entry", "install record", "directory"];
      const finalApplication = {
        operationId: "final",
        generation: 2,
        pluginIds: ["diffs"],
        sourceDigests: {},
      };
      const applyRuntime = vi
        .fn<PluginLifecycleRuntimeApply>()
        .mockResolvedValueOnce({
          ...application,
          sourceDigests: { workboard: "old" },
          warnings: [warning],
        })
        .mockResolvedValueOnce(finalApplication)
        .mockRejectedValueOnce(new Error("later apply rejected"));
      managementMocks.uninstall.mockImplementation(async (options) => {
        await options.applyRuntime(runtimeChange("uninstall"));
        const applied = await options.applyRuntime(runtimeChange("uninstall", "diffs"));
        if (rejectLater) {
          await options.applyRuntime(runtimeChange("uninstall", "diffs"));
        }
        return {
          application: applied,
          pluginId: "diffs",
          removed,
          warnings: ["npm prune skipped"],
        };
      });
      const result = await callHandler(
        "plugins.uninstall",
        { pluginId: "diffs" },
        {},
        applyRuntime,
      );
      if (rejectLater) {
        expectFailure(result, {
          code: "UNAVAILABLE",
          details: { runtime: { ...finalApplication, warnings: [warning], committed: true } },
        });
      } else {
        expectResponse(result, {
          pluginId: "diffs",
          removed,
          runtime: finalApplication,
          warnings: ["npm prune skipped", warning],
        });
      }
    },
  );

  it.each(["precommit", "persisted", "persisted-after-publication"] as const)(
    "reports persistence independently of runtime (%s)",
    async (stage) => {
      const runtimeFailure = new PluginRuntimeApplicationError(
        "candidate activation failed",
        {
          ...activation,
          operationId: "failed-activation",
          generation: 2,
        },
        { cause: new Error("plugin startup failure") },
      );
      const original = stage === "precommit" ? new Error("config write rejected") : runtimeFailure;
      managementMocks.install.mockImplementation(async (options) => {
        if (stage === "persisted-after-publication") {
          await options.applyRuntime(runtimeChange("install"));
        }
        throw stage === "precommit"
          ? original
          : new PluginInstallPersistedError("workboard", original);
      });
      const result = await callHandler("plugins.install", official());
      const persisted = stage !== "precommit";
      expectFailure(result, {
        code: "UNAVAILABLE",
        message: persisted ? expect.stringContaining(original.message) : original.message,
      });
      if (!persisted) {
        expect(result.error).not.toHaveProperty("details.persistence");
      } else {
        expect(result.error).toMatchObject({
          details: {
            persistence: { operation: "install", pluginId: "workboard" },
            ...(stage === "persisted-after-publication"
              ? {
                  runtime: { ...application, committed: true },
                  runtimeAttempt: runtimeFailure.details,
                }
              : { runtime: runtimeFailure.details }),
          },
        });
        if (stage === "persisted") {
          expect(result.error).toHaveProperty(
            "message",
            expect.stringContaining("plugin startup failure"),
          );
        }
      }
    },
  );

  it.each([
    [
      "install",
      clawhub(),
      { ...workboard, clawhubPackage: "community/workboard" },
      "ch_Y29tbXVuaXR5L3dvcmtib2FyZA",
    ],
    ["setEnabled", { pluginId: "workboard", enabled: false }, workboard, "local_d29ya2JvYXJk"],
  ] as const)(
    "returns the %s plugin with its catalog relation",
    async (method, params, plugin, id) => {
      managementMocks[method].mockResolvedValue({ plugin, application });
      expectResponse(await callHandler(`plugins.${method}`, params), {
        runtime: application,
        plugin: { ...plugin, catalogId: id },
      });
    },
  );

  it("rejects missing application receipts", async () => {
    managementMocks.reload.mockResolvedValue({ pluginIds: ["workboard"] });
    expectFailure(await callHandler("plugins.reload", { plugins: [{ pluginId: "workboard" }] }), {
      message: "Plugin lifecycle did not return a runtime application receipt.",
    });
  });

  it("forwards enablement policy and exact reviewed-surface token", async () => {
    managementMocks.setEnabled.mockResolvedValue({
      application,
      plugin: { ...workboard, enabled: true, state: "enabled" },
      changedPaths: ["plugins.entries.workboard.enabled"],
    });

    const request = {
      pluginId: "workboard",
      enabled: true,
      allowlistPolicy: "preserve",
      acknowledgeCapabilities: { reviewToken },
    };
    const result = await callHandler("plugins.setEnabled", request);
    expect(result.ok).toBe(true);
    expect(managementMocks.setEnabled).toHaveBeenCalledWith(expect.objectContaining(request));
  });

  it.each([
    ["blind acknowledgement", "setEnabled", { pluginId: "workboard", enabled: true }, true],
    ["missing review token", "install", official(), {}],
    ["extra acknowledgement properties", "install", clawhub(), { reviewToken, unexpected: true }],
  ] as const)(
    "rejects %s before dispatch",
    async (_label, method, params, acknowledgeCapabilities) => {
      const result = await callHandler(`plugins.${method}`, {
        ...params,
        acknowledgeCapabilities,
      });
      expectFailure(result, { code: "INVALID_REQUEST" });
      expect(managementMocks[method]).not.toHaveBeenCalled();
    },
  );

  const installPolicyWarning = {
    targetName: "diffs",
    targetType: "plugin" as const,
    requestMode: "install" as const,
    reason: "Review the staged package",
    findings: [
      {
        ruleId: "suspicious-script",
        severity: "warn" as const,
        message: "The package contains an install script.",
      },
    ],
  };
  it.each([
    {
      label: "stale capability consent",
      request: { ...official(), acknowledgeCapabilities: { reviewToken: "b".repeat(64) } },
      failure: new ManagedPluginLifecycleError("Plugin capability consent required", {
        capabilityConsent,
      }),
      code: "INVALID_REQUEST",
      details: {
        capabilityConsentCode: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
        ...capabilityConsent,
      },
    },
    {
      label: "tokenless install policy warning",
      request: official("diffs"),
      failure: new ManagedPluginLifecycleError("Review required", { installPolicyWarning }),
      code: "INVALID_REQUEST",
      details: {
        ...installPolicyWarning,
        installPolicyCode: "install_policy_warning_acknowledgement_required",
      },
    },
    {
      label: "ClawHub security outage",
      request: clawhub("community/plugin"),
      failure: new ManagedPluginLifecycleError("Security service unavailable", {
        kind: "unavailable",
        code: "clawhub_security_unavailable",
      }),
      code: "UNAVAILABLE",
      details: { clawhubTrustCode: "clawhub_security_unavailable" },
    },
  ])("reports $label", async ({ label, request, failure, code, details }) => {
    managementMocks.install.mockRejectedValue(failure);
    const { error } = await callHandler("plugins.install", request);
    expect(error).toMatchObject({ code, details });
    if (label === "stale capability consent") {
      expect(readCapabilityConsentErrorDetails(error?.details)).toEqual(details);
    } else if (label === "tokenless install policy warning") {
      expect(error).not.toHaveProperty("details.acknowledgementToken");
    }
  });
});
