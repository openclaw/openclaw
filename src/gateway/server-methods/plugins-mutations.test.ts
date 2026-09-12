// Plugin management mutation tests cover consent, publication, and cleanup outcomes.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCapabilityConsentErrorDetails,
  type CapabilityConsentErrorDetails,
} from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  PluginInstallPersistedError,
  PluginRuntimeApplicationError,
  type PluginLifecycleRuntimeApply,
} from "../../plugins/lifecycle.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import { OpenClawStateLeaseError } from "../../state/openclaw-state-lease.js";

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
) {
  let ok: boolean | null = null;
  let response: unknown;
  let error: unknown;
  await expectDefined(
    pluginMutationHandlers[method],
    "pluginMutationHandlers[method] test invariant",
  )({
    params,
    req: {} as never,
    // Minimal transport fixture: only the host-attested ingress marker is read here.
    client: (localClient ? { internal: { isLocalClient: true } } : null) as never,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => runtimeConfig,
      applyPluginLifecycleChange: applyRuntime,
    } as never,
    respond: (success, result, requestError) => {
      ok = success;
      response = result;
      error = requestError;
    },
  });
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

describe("plugin management Gateway mutation handlers", () => {
  beforeEach(() => {
    for (const mock of Object.values(managementMocks)) {
      mock.mockReset();
    }
  });

  it.each([
    { source: "local", path: "/tmp/demo.tgz" },
    { source: "npm-pack", archivePath: "/tmp/demo.tgz" },
    { source: "git", spec: "git:file:///tmp/demo.git" },
    { source: "marketplace", marketplace: "/tmp/marketplace", plugin: "demo" },
    { source: "marketplace", marketplace: "registered-marketplace", plugin: "demo" },
    { source: "marketplace", marketplace: "https://example.test/marketplace.json", plugin: "demo" },
  ])("requires host-attested local ingress for $source artifacts", async (request) => {
    managementMocks.install.mockResolvedValue({ plugin: workboard, application });
    expect(await callHandler("plugins.install", request)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("Gateway host") },
    });
    expect(managementMocks.install).not.toHaveBeenCalled();
    expect(await callHandler("plugins.install", request, {}, undefined, true)).toMatchObject({
      ok: true,
      response: { restartRequired: false, runtime: application },
    });
    expect(managementMocks.install).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ request }),
    );
  });

  it.each([
    { source: "npm", spec: "demo@1.2.3" },
    { source: "git", spec: "git:https://example.test/demo.git@v1" },
  ])("keeps remote $source source requests on the install owner", async (request) => {
    managementMocks.install.mockResolvedValue({ plugin: workboard, application });
    expect(await callHandler("plugins.install", request)).toHaveProperty("ok", true);
    expect(managementMocks.install).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ request }),
    );
  });

  it.each([undefined, ["Plugin cleanup did not finish; inspect the Gateway log."]])(
    "returns the completed runtime application and cleanup warnings %j from refresh",
    async (warnings) => {
      managementMocks.refreshMetadata.mockResolvedValue({
        application: { ...application, ...(warnings ? { warnings } : {}) },
      });
      expect(await callHandler("plugins.refresh", {})).toEqual({
        ok: true,
        response: {
          ok: true,
          restartRequired: false,
          runtime: application,
          ...(warnings ? { warnings } : {}),
        },
        error: undefined,
      });
    },
  );

  it("forwards exact batch owners and reports one applied reload receipt", async () => {
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
      application: { ...runtime, warnings: [warning] },
      warnings: [warning],
    });

    expect(await callHandler("plugins.reload", { plugins })).toEqual({
      ok: true,
      response: { ok: true, pluginIds, restartRequired: false, runtime, warnings: [warning] },
      error: undefined,
    });
    expect(managementMocks.reload).toHaveBeenCalledExactlyOnceWith({
      plugins,
      applyRuntime: expect.any(Function),
      beforePersistentApply: expect.any(Function),
    });
  });

  it.each([
    { label: "cleanup", error: new Error("file cleanup failed") },
    {
      label: "nested lease",
      error: new OpenClawStateLeaseError("package cleanup lease timed out", {
        code: "OPENCLAW_STATE_LEASE_TIMEOUT",
      }),
    },
  ])(
    "preserves an earlier publication without making a later $label failure retryable",
    async ({ error }) => {
      managementMocks.uninstall.mockImplementation(async (options) => {
        await options.applyRuntime({ config: {}, pluginIds: ["workboard"], reason: "uninstall" });
        throw error;
      });
      const result = await callHandler("plugins.uninstall", { pluginId: "workboard" });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: expect.stringContaining(error.message),
          details: { runtime: { ...application, committed: true } },
        },
      });
      expect(result.error).not.toHaveProperty("retryable");
    },
  );

  it.each([false, true])(
    "keeps successful application warnings with final facts when a later apply rejects: %s",
    async (rejectLater) => {
      const warning = "Previous plugin cleanup failed.";
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
        await options.applyRuntime({ config: {}, pluginIds: ["workboard"], reason: "uninstall" });
        const applied = await options.applyRuntime({
          config: {},
          pluginIds: ["diffs"],
          reason: "uninstall",
        });
        if (rejectLater) {
          await options.applyRuntime({ config: {}, pluginIds: ["diffs"], reason: "uninstall" });
        }
        return { application: applied, pluginId: "diffs", removed: [] };
      });
      const result = await callHandler(
        "plugins.uninstall",
        { pluginId: "diffs" },
        {},
        applyRuntime,
      );
      if (rejectLater) {
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            details: { runtime: { ...finalApplication, warnings: [warning], committed: true } },
          },
        });
      } else {
        expect(result).toEqual({
          ok: true,
          response: {
            ok: true,
            pluginId: "diffs",
            removed: [],
            restartRequired: false,
            runtime: finalApplication,
            warnings: [warning],
          },
          error: undefined,
        });
      }
    },
  );

  it.each(["precommit", "persisted", "persisted-after-publication"] as const)(
    "reports install persistence independently of runtime for %s failure",
    async (stage) => {
      const runtimeFailure = new PluginRuntimeApplicationError(
        "candidate activation failed",
        {
          operationId: "failed-activation",
          generation: 2,
          pluginIds: ["workboard"],
          phase: "activate",
          committed: false,
        },
        { cause: new Error("plugin startup failure") },
      );
      const original = stage === "precommit" ? new Error("config write rejected") : runtimeFailure;
      managementMocks.install.mockImplementation(async (options) => {
        if (stage === "persisted-after-publication") {
          await options.applyRuntime({ config: {}, pluginIds: ["workboard"], reason: "install" });
        }
        throw stage === "precommit"
          ? original
          : new PluginInstallPersistedError("workboard", original);
      });
      const result = await callHandler("plugins.install", {
        source: "official",
        pluginId: "workboard",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({ code: "UNAVAILABLE" });
      if (stage === "precommit") {
        expect(result.error).not.toHaveProperty("details.persistence");
        expect(result.error).toHaveProperty("message", original.message);
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
          expect(result.error).toHaveProperty("message", expect.stringContaining(original.message));
          expect(result.error).toHaveProperty(
            "message",
            expect.stringContaining("plugin startup failure"),
          );
        } else {
          expect(result.error).toHaveProperty("message", expect.stringContaining(original.message));
        }
      }
    },
  );

  it("reports a saved install when later metadata inspection fails without a runtime attempt", async () => {
    managementMocks.install.mockRejectedValue(
      new PluginInstallPersistedError("workboard", new Error("metadata unavailable")),
    );
    expect(
      await callHandler("plugins.install", { source: "official", pluginId: "workboard" }),
    ).toMatchObject({
      ok: false,
      error: {
        message: "metadata unavailable",
        details: { persistence: { operation: "install", pluginId: "workboard" } },
      },
    });
  });

  it("rejects a mutation that returns no application receipt", async () => {
    managementMocks.reload.mockResolvedValue({ pluginIds: ["workboard"] });
    expect(
      await callHandler("plugins.reload", { plugins: [{ pluginId: "workboard" }] }),
    ).toMatchObject({
      ok: false,
      error: { message: "Plugin lifecycle did not return a runtime application receipt." },
    });
  });

  it("returns applied runtime state for enablement", async () => {
    managementMocks.setEnabled.mockResolvedValue({
      application,
      plugin: { ...workboard, enabled: true, state: "enabled" },
      changedPaths: ["plugins.entries.workboard.enabled"],
      warnings: ['Exclusive slot "memory" switched to "workboard".'],
    });

    const result = await callHandler("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
    });

    expect(managementMocks.setEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "workboard",
        enabled: true,
      }),
    );
    expect(result.response).toMatchObject({
      ok: true,
      restartRequired: false,
      warnings: ['Exclusive slot "memory" switched to "workboard".'],
    });
  });

  it("forwards preserve policy and the exact reviewed-surface token when enabling a plugin", async () => {
    managementMocks.setEnabled.mockResolvedValue({
      application,
      plugin: { ...workboard, enabled: true, state: "enabled" },
      changedPaths: ["plugins.entries.workboard.enabled"],
    });

    const result = await callHandler("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
      allowlistPolicy: "preserve",
      acknowledgeCapabilities: { reviewToken },
    });

    expect(result.ok).toBe(true);
    expect(managementMocks.setEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "workboard",
        enabled: true,
        allowlistPolicy: "preserve",
        acknowledgeCapabilities: { reviewToken },
      }),
    );
  });

  it.each([
    {
      label: "enablement with obsolete blind acknowledgement",
      method: "plugins.setEnabled",
      params: { pluginId: "workboard", enabled: true },
      mock: managementMocks.setEnabled,
      acknowledgement: true,
    },
    {
      label: "an official install with a missing review token",
      method: "plugins.install",
      params: { source: "official", pluginId: "workboard" },
      mock: managementMocks.install,
      acknowledgement: {},
    },
    {
      label: "a ClawHub install with extra acknowledgement properties",
      method: "plugins.install",
      params: { source: "clawhub", packageName: "community/workboard" },
      mock: managementMocks.install,
      acknowledgement: { reviewToken, unexpected: true },
    },
  ])("rejects $label before dispatch", async (testCase) => {
    const result = await callHandler(testCase.method, {
      ...testCase.params,
      acknowledgeCapabilities: testCase.acknowledgement,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(testCase.mock).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "an initial enable request",
      method: "plugins.setEnabled",
      params: { pluginId: "workboard", enabled: true },
      mock: managementMocks.setEnabled,
    },
    {
      label: "an install request with a stale review token",
      method: "plugins.install",
      params: {
        source: "official",
        pluginId: "workboard",
        acknowledgeCapabilities: { reviewToken: "b".repeat(64) },
      },
      mock: managementMocks.install,
    },
  ])("returns fresh server-authoritative consent details for $label", async (testCase) => {
    testCase.mock.mockRejectedValue(
      new ManagedPluginLifecycleError("Plugin capability consent required", {
        capabilityConsent,
      }),
    );

    const result = await callHandler(testCase.method, testCase.params);
    const error = result.error as { code?: string; details?: unknown };

    expect(error.code).toBe("INVALID_REQUEST");
    expect(readCapabilityConsentErrorDetails(error.details)).toEqual({
      capabilityConsentCode: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
      ...capabilityConsent,
    });
  });

  it.each(["off", "restart", "hot"] as const)(
    "reports restartRequired=false for %s reload mode",
    async (mode) => {
      managementMocks.setEnabled.mockResolvedValue({
        application,
        plugin: { ...workboard, enabled: true, state: "enabled" },
        changedPaths: ["plugins.entries.workboard.enabled"],
      });

      const result = await callHandler(
        "plugins.setEnabled",
        { pluginId: "workboard", enabled: true },
        { gateway: { reload: { mode } } },
      );

      expect(result.response).toMatchObject({ ok: true, restartRequired: false });
    },
  );

  it.each([
    {
      error: new ManagedPluginLifecycleError("Plugin is blocked"),
      code: "INVALID_REQUEST",
    },
    { error: new Error("rename EACCES"), code: "UNAVAILABLE" },
  ])("classifies enablement failures as $code", async ({ error, code }) => {
    const message = error.message;
    managementMocks.setEnabled.mockRejectedValue(error);

    const result = await callHandler("plugins.setEnabled", {
      pluginId: "workboard",
      enabled: true,
    });

    expect(result.error).toMatchObject({ code, message });
  });

  it.each([
    {
      source: "clawhub",
      packageName: "@openclaw/diffs",
      version: "1.2.3",
      acknowledgeCapabilities: { reviewToken },
    },
    {
      source: "official",
      pluginId: "diffs",
      acknowledgeInstallPolicyWarning: true,
      acknowledgeCapabilities: { reviewToken },
    },
  ])(
    "forwards $source install acknowledgements and the exact reviewed-surface token",
    async (request) => {
      managementMocks.install.mockResolvedValue({
        application,
        plugin: { ...workboard, id: "diffs", name: "Diffs", enabled: true, state: "enabled" },
      });

      await callHandler("plugins.install", structuredClone(request));

      expect(managementMocks.install).toHaveBeenCalledWith(expect.objectContaining({ request }));
    },
  );

  it("returns tokenless structured install policy warning details", async () => {
    managementMocks.install.mockRejectedValue(
      new ManagedPluginLifecycleError("Review required", {
        installPolicyWarning: {
          targetName: "diffs",
          targetType: "plugin",
          requestMode: "install",
          reason: "Review the staged package",
          findings: [
            {
              ruleId: "suspicious-script",
              severity: "warn",
              message: "The package contains an install script.",
            },
          ],
        },
      }),
    );

    const result = await callHandler("plugins.install", {
      source: "official",
      pluginId: "diffs",
    });

    expect(result.error).toMatchObject({
      code: "INVALID_REQUEST",
      details: {
        installPolicyCode: "install_policy_warning_acknowledgement_required",
        targetName: "diffs",
        targetType: "plugin",
        requestMode: "install",
        reason: "Review the staged package",
        findings: [
          {
            ruleId: "suspicious-script",
            severity: "warn",
            message: "The package contains an install script.",
          },
        ],
      },
    });
    expect(result.error).not.toHaveProperty("details.acknowledgementToken");
  });

  it("classifies ClawHub security outages as unavailable", async () => {
    managementMocks.install.mockRejectedValue(
      new ManagedPluginLifecycleError("Security service unavailable", {
        kind: "unavailable",
        code: "clawhub_security_unavailable",
      }),
    );

    const result = await callHandler("plugins.install", {
      source: "clawhub",
      packageName: "community/plugin",
    });

    expect(result.error).toMatchObject({
      code: "UNAVAILABLE",
      details: { clawhubTrustCode: "clawhub_security_unavailable" },
    });
  });

  it("classifies unexpected install persistence failures as unavailable", async () => {
    managementMocks.install.mockRejectedValue(new Error("disk full"));

    const result = await callHandler("plugins.install", {
      source: "clawhub",
      packageName: "community/plugin",
    });

    expect(result.error).toMatchObject({
      code: "UNAVAILABLE",
      message: "disk full",
    });
  });

  it("returns removal actions and applied runtime after uninstall", async () => {
    managementMocks.uninstall.mockResolvedValue({
      application,
      pluginId: "diffs",
      removed: ["config entry", "install record", "directory"],
      warnings: ["npm prune skipped"],
    });

    const result = await callHandler("plugins.uninstall", { pluginId: "diffs" });

    expect(managementMocks.uninstall).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "diffs" }),
    );
    expect(result).toEqual({
      ok: true,
      response: {
        ok: true,
        pluginId: "diffs",
        restartRequired: false,
        runtime: application,
        removed: ["config entry", "install record", "directory"],
        warnings: ["npm prune skipped"],
      },
      error: undefined,
    });
  });

  it("classifies bundled uninstall refusals as invalid requests", async () => {
    managementMocks.uninstall.mockRejectedValue(
      new ManagedPluginLifecycleError(
        "bundled plugin cannot be uninstalled: workboard; disable it instead",
      ),
    );

    const result = await callHandler("plugins.uninstall", { pluginId: "workboard" });

    expect(result.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "bundled plugin cannot be uninstalled: workboard; disable it instead",
    });
  });
});
