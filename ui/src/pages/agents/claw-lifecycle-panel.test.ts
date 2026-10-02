/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import type { ClawStatusRecord } from "../agents-home/claws-catalog-client.ts";
import type { ClawLifecyclePlan, ClawUpdatePlan } from "./claw-lifecycle-client.ts";
import { AgentClawPanel } from "./claw-lifecycle-panel.ts";

const installed: ClawStatusRecord = {
  agentId: "workflow",
  name: "@openclaw/workflow-operator",
  version: "1.2.0",
  sourceKind: "package",
  status: "complete",
  agentState: "present",
  bootstrapState: "complete",
  orphaned: false,
  addedAtMs: 1_000,
  updatedAtMs: 2_000,
  resources: [
    { kind: "agent", id: "workflow", state: "present", relationship: "managed" },
    {
      kind: "plugin",
      id: "workflow-tools",
      state: "present",
      relationship: "referenced",
      origin: "pre-existing",
      independentOwner: true,
    },
  ],
};

const updatePluginReview = {
  actionId: "package:workflow-tools",
  pluginId: "workflow-tools",
  ref: "@openclaw/workflow-tools",
  version: "1.3.0",
  ownerAction: "install" as const,
  declaredCapabilities: {
    channels: [],
    providers: [],
    tools: ["workflow.start"],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  },
  capabilityGrants: {
    hooks: {
      allowPromptInjection: { effective: false },
      allowConversationAccess: { effective: true },
    },
  },
  reviewToken: "review-workflow-tools-1.3.0",
};

const updatePlan: ClawUpdatePlan = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "update",
  planIntegrity: "sha256:update-plan",
  target: {
    agentId: "workflow",
    name: installed.name,
    currentVersion: installed.version,
    targetVersion: "1.3.0",
  },
  actions: [
    {
      kind: "plugin",
      id: "workflow-tools",
      action: "install",
      blocked: false,
    },
  ],
  capabilities: [
    {
      kind: "plugin",
      id: "workflow-tools",
      action: "grant",
      reason: "Start approved workflows",
    },
  ],
  pluginReviews: [updatePluginReview],
  blockers: [],
  riskAcknowledgementRequired: false,
  configuredAccess: {
    coverage: "configuration-only",
    current: {
      tools: { allowed: ["read"], excluded: ["exec"] },
      sandbox: { mode: "non-main", scope: "agent", workspaceAccess: "ro", backend: "docker" },
      filesystem: { workspaceOnly: true },
      heartbeat: { enabled: false, intervalMs: null },
      memorySearch: { state: "disabled" },
      subagentTargets: {
        allowedAgentIds: ["workflow"],
        allowAnyConfiguredAgent: false,
        implicitSelfAllowed: true,
        requireAgentId: false,
      },
    },
    desired: {
      tools: { allowed: ["read", "workflow.start"], excluded: ["exec"] },
      sandbox: { mode: "non-main", scope: "agent", workspaceAccess: "ro", backend: "docker" },
      filesystem: { workspaceOnly: true },
      heartbeat: { enabled: false, intervalMs: null },
      memorySearch: { state: "disabled" },
      subagentTargets: {
        allowedAgentIds: ["workflow"],
        allowAnyConfiguredAgent: false,
        implicitSelfAllowed: true,
        requireAgentId: false,
      },
    },
    unresolved: ["runtime-tools", "sandbox-runtime", "memory-runtime", "scheduler-runtime"],
  },
  scheduledJobs: { coverage: "package-declarations", jobs: [] },
  readiness: { ready: true, requirements: [] },
};

const removePlan: ClawLifecyclePlan = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "remove",
  planIntegrity: "sha256:remove-plan",
  target: { agentId: "workflow", name: installed.name, currentVersion: installed.version },
  actions: [
    { kind: "agent", id: "workflow", action: "delete", blocked: false },
    {
      kind: "plugin",
      id: "workflow-tools",
      action: "retain",
      blocked: false,
    },
  ],
  capabilities: [],
  blockers: [],
  pluginReviews: [],
  riskAcknowledgementRequired: false,
};

function mount(
  options: {
    clawsEnabled?: boolean;
    record?: ClawStatusRecord | null;
    plan?: ClawLifecyclePlan;
    applyError?: boolean;
    removeRejectedOnce?: boolean;
    applyResult?: { agentId: string; status: "complete" | "partial"; agentRemoved: boolean };
    latestVersion?: string;
    updatePlan?: ClawUpdatePlan;
    updateApplyError?: boolean;
    updateRejectedOnce?: boolean;
    updateAppliedBeforeError?: boolean;
    updateApplyResult?: { agentId: string; status: string; readiness: { ready: boolean } };
  } = {},
) {
  let record: ClawStatusRecord | null = options.record === undefined ? installed : options.record;
  let rejectedRemove = false;
  let rejectedUpdate = false;
  let clawsEnabled = options.clawsEnabled ?? false;
  const latestVersion = options.latestVersion ?? "1.3.0";
  const plannedUpdate =
    options.updatePlan ??
    ({
      ...updatePlan,
      target: { ...updatePlan.target, targetVersion: latestVersion },
    } satisfies ClawUpdatePlan);
  const request = createGatewayRequestMock(async (method) => {
    if (method === "claws.status") {
      return { records: record ? [record] : [] };
    }
    if (method === "claws.catalog.search") {
      return {
        entries: [
          {
            packageName: "@openclaw/workflow-operator",
            displayName: "Workflow Operator",
            latestVersion,
            channel: "official",
            official: true,
          },
        ],
      };
    }
    if (method === "claws.catalog.detail") {
      return {
        detail: {
          packageName: "@openclaw/workflow-operator",
          displayName: "Workflow Operator",
          version: latestVersion,
          latestVersion,
          channel: "official",
          official: true,
          workspaceFiles: 1,
          skills: 0,
          plugins: 1,
          mcpServers: 0,
          scheduledJobs: 0,
        },
      };
    }
    if (method === "claws.update.plan") {
      return plannedUpdate;
    }
    if (method === "claws.update.apply") {
      if (options.updateRejectedOnce && !rejectedUpdate) {
        rejectedUpdate = true;
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "The Claw changed since review. Preview it again.",
        });
      }
      if (options.updateApplyError) {
        if (options.updateAppliedBeforeError && record) {
          record = { ...record, version: latestVersion, updatedAtMs: 3_000 };
        }
        throw new Error("Gateway reply timed out");
      }
      if (record) {
        record = { ...record, version: latestVersion, updatedAtMs: 3_000 };
      }
      return (
        options.updateApplyResult ?? {
          agentId: "workflow",
          status: "complete",
          readiness: { ready: true },
        }
      );
    }
    if (method === "claws.remove.plan") {
      return options.plan ?? removePlan;
    }
    if (method === "claws.remove.apply") {
      if (options.removeRejectedOnce && !rejectedRemove) {
        rejectedRemove = true;
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "The removal plan changed. Preview it again.",
        });
      }
      if (options.applyError) {
        throw new Error("Gateway reply timed out");
      }
      const result = options.applyResult ?? {
        agentId: "workflow",
        status: "complete" as const,
        agentRemoved: true,
      };
      if (result.agentRemoved) {
        record = null;
      }
      return result;
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const source = createApplicationGateway({
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(
      [
        "claws.status",
        "claws.catalog.search",
        "claws.catalog.detail",
        "claws.update.plan",
        "claws.update.apply",
        "claws.remove.plan",
        "claws.remove.apply",
      ],
      ["operator.read", "operator.admin"],
    ),
    assistantAgentId: "workflow",
    sessionKey: "agent:workflow:main",
    lastError: null,
    lastErrorCode: null,
  });
  const navigate = vi.fn<ApplicationContext["navigate"]>();
  const refreshList = vi.fn(async () => ({
    agents: record ? [{ id: "workflow" }] : [],
    defaultId: "main",
    mainKey: "main",
  }));
  const runtimeConfigListeners = new Set<() => void>();
  const runtimeConfig = {
    state: {
      configSnapshot: {
        sourceConfig: {
          gateway: { controlUi: { experimental: { claws: clawsEnabled } } },
        },
      },
    },
    ensureLoaded: async () => undefined,
    subscribe: (listener: () => void) => {
      runtimeConfigListeners.add(listener);
      return () => runtimeConfigListeners.delete(listener);
    },
  };
  const provider = createApplicationContextProvider({
    gateway: source.gateway,
    agents: { refreshList },
    runtimeConfig,
    navigate,
  } as unknown as ApplicationContext);
  const panel = document.createElement("openclaw-agent-claw-panel") as AgentClawPanel;
  panel.agentId = "workflow";
  provider.append(panel);
  document.body.append(provider);
  return {
    panel,
    request,
    navigate,
    refreshList,
    source,
    setClawsEnabled: (enabled: boolean) => {
      clawsEnabled = enabled;
      runtimeConfig.state.configSnapshot.sourceConfig.gateway.controlUi.experimental.claws =
        enabled;
      for (const listener of runtimeConfigListeners) {
        listener();
      }
    },
  };
}

beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("Agent Claw lifecycle", () => {
  it("shows installed status and allows reviewed removal while Labs is off", async () => {
    const { panel, request, navigate } = mount();
    await vi.waitFor(() => expect(panel.textContent).toContain("@openclaw/workflow-operator"));
    expect(request).toHaveBeenCalledWith("claws.status", { target: "workflow" });
    expect(panel.textContent).toContain("workflow-tools");
    expect(panel.textContent).toContain("Referenced");
    expect(panel.textContent).toContain("Shared");
    expect(panel.querySelector("[data-claw-update]")).toBeNull();

    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector("[data-claw-remove-confirm]")).not.toBeNull(),
    );
    expect(panel.textContent).toContain("Kept");
    expect(request).not.toHaveBeenCalledWith("claws.remove.apply", expect.anything());

    panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.remove.apply", {
        agentId: "workflow",
        planIntegrity: "sha256:remove-plan",
      }),
    );
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("agents"));
  });

  it("does not call apply for a blocked removal plan", async () => {
    const blocked = {
      ...removePlan,
      blockers: [{ code: "shared_agent", path: "resources.agent", message: "Agent is shared" }],
    };
    const { panel, request } = mount({ plan: blocked });
    await vi.waitFor(() => expect(panel.textContent).toContain(installed.name));
    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Agent is shared"));
    expect(panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
      true,
    );
    expect(request.mock.calls.some(([method]) => method === "claws.remove.apply")).toBe(false);
  });

  it("keeps an ambiguous removal pending and never sends a second apply", async () => {
    const { panel, request, navigate } = mount({ applyError: true });
    await vi.waitFor(() => expect(panel.textContent).toContain(installed.name));
    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector("[data-claw-remove-confirm]")).not.toBeNull(),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Removal outcome unknown"));
    expect(panel.querySelector("[data-claw-remove-confirm]")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      1,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("replans after a definite Remove rejection without status reconciliation", async () => {
    const { panel, request, navigate } = mount({ removeRejectedOnce: true });
    await vi.waitFor(() => expect(panel.textContent).toContain(installed.name));
    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    const statusCallsBeforeApply = request.mock.calls.filter(
      ([method]) => method === "claws.status",
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Preview it again"));
    expect(panel.textContent).not.toContain("Removal outcome unknown");
    expect(panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
      true,
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.status")).toHaveLength(
      statusCallsBeforeApply.length,
    );

    panel
      .querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__body .callout.danger button")
      ?.click();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "claws.remove.plan")).toHaveLength(
        2,
      ),
    );
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("agents"));
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      2,
    );
  });

  it("requires a fresh status read before replanning a partial removal", async () => {
    const { panel, request } = mount({
      applyResult: { agentId: "workflow", status: "partial", agentRemoved: false },
    });
    await vi.waitFor(() => expect(panel.textContent).toContain(installed.name));
    panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector("[data-claw-remove-confirm]")).not.toBeNull(),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Removal incomplete"));
    panel.querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__footer .btn")?.click();
    await vi.waitFor(() => expect(panel.querySelector(".claw-lifecycle-dialog")).toBeNull());
    expect(panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.disabled).toBe(
      true,
    );

    panel.querySelector<HTMLButtonElement>(".settings-section__actions .btn")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.disabled).toBe(
        false,
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      1,
    );
  });

  it("does not add a Claw section to an ordinary agent", async () => {
    const { panel, request } = mount({ record: null });
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.status", { target: "workflow" }),
    );
    await settleLitElement(panel);
    expect(panel.textContent).toBe("");
  });

  it("reviews an exact official update and passes plugin grants to one apply call", async () => {
    const { panel, request } = mount({ clawsEnabled: true });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("workflow.start"));
    expect(request).toHaveBeenCalledWith("claws.catalog.search", {
      query: "@openclaw/workflow-operator",
      limit: 100,
    });
    expect(request).toHaveBeenCalledWith("claws.catalog.detail", {
      packageName: "@openclaw/workflow-operator",
      version: "1.3.0",
    });
    expect(request).toHaveBeenCalledWith("claws.update.plan", {
      agentId: "workflow",
      source: { packageName: "@openclaw/workflow-operator", version: "1.3.0" },
    });
    expect(panel.textContent).toContain("Conversation access");
    expect(panel.textContent).toContain("Configured access");
    expect(panel.textContent).toContain("Current");
    expect(panel.textContent).toContain("After Update");
    expect(request).not.toHaveBeenCalledWith("claws.update.apply", expect.anything());

    panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.update.apply", {
        agentId: "workflow",
        source: { packageName: "@openclaw/workflow-operator", version: "1.3.0" },
        planIntegrity: "sha256:update-plan",
        acknowledgeCapabilities: [
          {
            actionId: "package:workflow-tools",
            pluginId: "workflow-tools",
            reviewToken: "review-workflow-tools-1.3.0",
            capabilityGrants: updatePluginReview.capabilityGrants,
          },
        ],
      }),
    );
    await vi.waitFor(() => expect(panel.textContent).toContain("Claw updated"));
    expect(request.mock.calls.filter(([method]) => method === "claws.update.apply")).toHaveLength(
      1,
    );
  });

  it("refuses an Update whose configured access cannot be disclosed", async () => {
    const { panel, request } = mount({
      clawsEnabled: true,
      updatePlan: { ...updatePlan, configuredAccess: undefined },
    });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(panel.textContent).toContain("Access or schedule review is unavailable"),
    );
    expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
      true,
    );
    expect(request.mock.calls.some(([method]) => method === "claws.update.apply")).toBe(false);
  });

  it("requires separate ClawHub and plugin-risk acknowledgments on Update", async () => {
    const plan: ClawUpdatePlan = {
      ...updatePlan,
      trustWarning: "ClawHub requests review of this release.",
      riskAcknowledgementRequired: true,
      pluginReviews: [
        { ...updatePluginReview, riskWarning: "Plugin can access customer conversations." },
      ],
    };
    const { panel, request } = mount({ clawsEnabled: true, updatePlan: plan });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("customer conversations"));
    const confirm = panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]");
    expect(confirm?.disabled).toBe(true);
    panel.querySelector<HTMLInputElement>("[data-claw-plugin-risk]")?.click();
    await vi.waitFor(() => expect(confirm?.disabled).toBe(true));
    panel.querySelector<HTMLInputElement>(".claw-lifecycle-dialog__risk input")?.click();
    await vi.waitFor(() => expect(confirm?.disabled).toBe(false));
    confirm?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "claws.update.apply",
        expect.objectContaining({
          acknowledgeClawHubRisk: true,
          acknowledgeCapabilities: [
            expect.objectContaining({
              pluginId: "workflow-tools",
              acknowledgeRiskWarning: true,
            }),
          ],
        }),
      ),
    );
  });

  it("shows an up-to-date release without planning an Update", async () => {
    const { panel, request } = mount({ clawsEnabled: true, latestVersion: "1.2.0" });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("This Claw is up to date"));
    expect(panel.querySelector("[data-claw-update-confirm]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "claws.update.plan")).toBe(false);
  });

  it("hides Update for local Claws and disables an open review when Labs turns off", async () => {
    const local = mount({
      clawsEnabled: true,
      record: { ...installed, name: "local-workflow", sourceKind: "development" },
    });
    await vi.waitFor(() => expect(local.panel.textContent).toContain("local-workflow"));
    expect(local.panel.querySelector("[data-claw-update]")).toBeNull();

    const official = mount({ clawsEnabled: true });
    await vi.waitFor(() =>
      expect(official.panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(
        false,
      ),
    );
    official.panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(
        official.panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled,
      ).toBe(false),
    );
    official.setClawsEnabled(false);
    await vi.waitFor(() =>
      expect(
        official.panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled,
      ).toBe(true),
    );
    expect(official.panel.textContent).toContain("Turn Claws on in Labs");
    official.panel.querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__footer .btn")?.click();
    await vi.waitFor(() => expect(official.panel.querySelector("[data-claw-update]")).toBeNull());
    expect(
      official.panel.querySelector<HTMLButtonElement>(".settings-row .btn.danger")?.disabled,
    ).toBe(false);
    expect(official.request.mock.calls.some(([method]) => method === "claws.update.apply")).toBe(
      false,
    );
  });

  it("keeps an ambiguous Update pending and never sends another apply", async () => {
    const { panel, request } = mount({ clawsEnabled: true, updateApplyError: true });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
        false,
      ),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Update outcome unknown"));
    expect(panel.querySelector("[data-claw-update-confirm]")).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.update.apply")).toHaveLength(
      1,
    );
    panel.querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__footer .btn")?.click();
    await vi.waitFor(() => expect(panel.querySelector(".claw-lifecycle-dialog")).toBeNull());
    expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(true);
  });

  it("replans after a definite Update rejection without status reconciliation", async () => {
    const { panel, request } = mount({ clawsEnabled: true, updateRejectedOnce: true });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
        false,
      ),
    );
    const statusCallsBeforeApply = request.mock.calls.filter(
      ([method]) => method === "claws.status",
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Preview it again"));
    expect(panel.textContent).not.toContain("Update outcome unknown");
    expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
      true,
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.status")).toHaveLength(
      statusCallsBeforeApply.length,
    );

    panel
      .querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__body .callout.danger button")
      ?.click();
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === "claws.update.plan")).toHaveLength(
        2,
      ),
    );
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
        false,
      ),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Claw updated"));
    expect(request.mock.calls.filter(([method]) => method === "claws.update.apply")).toHaveLength(
      2,
    );
  });

  it("reconciles a timed-out Update from status without sending another apply", async () => {
    const { panel, request } = mount({
      clawsEnabled: true,
      updateApplyError: true,
      updateAppliedBeforeError: true,
    });
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.disabled).toBe(false),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update]")?.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.disabled).toBe(
        false,
      ),
    );
    panel.querySelector<HTMLButtonElement>("[data-claw-update-confirm]")?.click();
    await vi.waitFor(() => expect(panel.textContent).toContain("Claw updated"));
    expect(panel.textContent).not.toContain("Update outcome unknown");
    expect(request.mock.calls.filter(([method]) => method === "claws.update.apply")).toHaveLength(
      1,
    );
  });
});
