import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClawConfiguredAccess,
  ClawLifecyclePlanResult,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubClawTrust } from "./clawhub-source.js";
import { ClawGatewayPlanChangedError } from "./gateway-add-apply.js";
import { applyClawUpdateForGateway } from "./gateway-update-apply.js";
import type { ClawReadResult } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan-types.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  lease: vi.fn(),
  prepare: vi.fn(),
  build: vi.fn(),
  bindTrust: vi.fn(),
  plansMatch: vi.fn(),
  consent: vi.fn(),
  apply: vi.fn(),
  persist: vi.fn(),
  owned: vi.fn(),
  configuredAccess: vi.fn(),
}));

vi.mock("./clawhub-source.js", () => ({ withResolvedClawHubSource: mocks.resolve }));
vi.mock("../state/openclaw-state-lease.js", () => ({ withOpenClawStateLease: mocks.lease }));
vi.mock("./gateway-lifecycle-plan.js", () => ({
  prepareGatewayClawUpdatePlanning: mocks.prepare,
  buildGatewayClawUpdatePlan: mocks.build,
}));
vi.mock("./gateway-plan-projection.js", () => ({
  bindClawLifecycleTrust: mocks.bindTrust,
  plansMatchAcrossSourceRoots: mocks.plansMatch,
}));
vi.mock("./gateway-plugin-consent.js", () => ({ bindClawPluginInstallConsent: mocks.consent }));
vi.mock("./gateway-disclosure.js", () => ({ projectClawConfiguredAccess: mocks.configuredAccess }));
vi.mock("./update-apply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-apply.js")>()),
  applyClawUpdatePlan: mocks.apply,
}));

const coordinate = { packageName: "@openclaw/workflow-operator", version: "1.2.0" };
const source = {
  source: { packageRoot: "/tmp/extracted", name: coordinate.packageName },
  manifest: { mcpServers: {} },
} as Extract<ClawReadResult, { ok: true }>;
const persistedSource = {
  source: { packageRoot: "/tmp/verified-cache", name: coordinate.packageName },
  manifest: { mcpServers: {} },
} as Extract<ClawReadResult, { ok: true }>;
const trust: ClawHubClawTrust = {
  riskAcknowledgementRequired: false,
  trustRecord: {
    clawhubTrustDisposition: "clean",
    clawhubTrustCheckedAt: "2026-09-30T00:00:00.000Z",
  },
};
const plan = {
  agentId: "workflow-operator",
  planIntegrity: "sha256:canonical",
  blockers: [],
  actions: [],
} as unknown as ClawUpdatePlan;
const accessSnapshot = {
  tools: { allowed: [], excluded: [], explicitAllow: [], explicitDeny: [] },
  sandbox: { mode: "off", scope: "agent", workspaceAccess: "none", backend: "other" },
  filesystem: { workspaceOnly: false },
  heartbeat: { enabled: false, intervalMs: null },
  memorySearch: { state: "disabled" },
  subagentTargets: {
    allowedAgentIds: [],
    allowAnyConfiguredAgent: false,
    implicitSelfAllowed: false,
    requireAgentId: false,
  },
} satisfies NonNullable<ClawConfiguredAccess["desired"]>;
const reviewedAccess: ClawConfiguredAccess = {
  coverage: "configuration-only",
  current: accessSnapshot,
  desired: accessSnapshot,
  unresolved: ["runtime-tools"],
};
const projection: ClawLifecyclePlanResult = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "update",
  planIntegrity: "sha256:reviewed",
  target: { agentId: "workflow-operator", currentVersion: "1.0.0", targetVersion: "1.2.0" },
  actions: [],
  capabilities: [],
  pluginReviews: [],
  skillReviews: [],
  blockers: [],
  riskAcknowledgementRequired: false,
  configuredAccess: reviewedAccess,
  readiness: { ready: true, requirements: [] },
};
const skillReview = {
  actionId: "skill:@community/triage",
  ref: "@community/triage",
  version: "2.0.0",
  integrity: "sha256:updated-skill",
  riskWarning: "This skill release requires review.",
  reviewToken: "sha256:updated-skill-review",
};
const config: OpenClawConfig = { gateway: { controlUi: { experimental: { claws: true } } } };
const packagePreflight = vi.fn();
const packageDeps = { resolvePlugin: vi.fn() };
const prepared = { stateOptions: { env: {} }, packagePreflight, packageDeps };
const built = {
  plan,
  projection,
  stateOptions: prepared.stateOptions,
  packagePreflight,
  packageDeps,
  sourceMcpServers: {},
};

function applyInput() {
  return {
    agentId: "workflow-operator",
    source: coordinate,
    planIntegrity: projection.planIntegrity,
    getRuntimeConfig: vi.fn(() => config),
    assertCurrent: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockImplementation(
    async (input: {
      run: (
        artifact: typeof source,
        trust: ClawHubClawTrust,
        persist: () => Promise<typeof persistedSource>,
      ) => Promise<unknown>;
    }) => ({ value: await input.run(source, trust, mocks.persist), ...trust }),
  );
  mocks.persist.mockResolvedValue(persistedSource);
  mocks.lease.mockImplementation(
    async (_options: unknown, run: (lease: { assertOwned: () => void }) => Promise<unknown>) =>
      await run({ assertOwned: mocks.owned }),
  );
  mocks.prepare.mockResolvedValue(prepared);
  mocks.build.mockResolvedValue(built);
  mocks.bindTrust.mockImplementation((value) => value);
  mocks.plansMatch.mockReturnValue(true);
  mocks.configuredAccess.mockReturnValue(reviewedAccess);
  mocks.apply.mockResolvedValue({ agentId: "workflow-operator", status: "complete" });
});

describe("Gateway Claw Update application", () => {
  it("replans the verified release under a lease and uses the canonical worker updater", async () => {
    const input = applyInput();
    const result = await applyClawUpdateForGateway(input);

    expect(result).toEqual({
      agentId: "workflow-operator",
      status: "complete",
      readiness: { ready: true, requirements: [] },
    });
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "apply", coordinate }),
    );
    expect(mocks.prepare).toHaveBeenCalledTimes(3);
    expect(mocks.build).toHaveBeenCalledTimes(3);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.plansMatch).toHaveBeenCalledWith({
      preview: plan,
      previewRoot: "/tmp/extracted",
      persisted: plan,
      persistedRoot: "/tmp/verified-cache",
    });
    expect(mocks.apply).toHaveBeenCalledWith(
      plan,
      expect.objectContaining({
        targetManifest: persistedSource.manifest,
        targetSource: persistedSource.source,
      }),
      expect.objectContaining({
        stateMode: "worker",
        config,
        getCurrentConfig: input.getRuntimeConfig,
        sourceMcpServers: {},
        packagePreflight,
        planPackageDeps: packageDeps,
        consentPlanIntegrity: plan.planIntegrity,
        assertCurrent: expect.any(Function),
      }),
    );
    expect(mocks.owned).toHaveBeenCalled();
  });

  it("refuses a stale plan and missing plugin consent before persisting any source", async () => {
    const input = applyInput();
    input.planIntegrity = "sha256:stale";
    await expect(applyClawUpdateForGateway(input)).rejects.toBeInstanceOf(
      ClawGatewayPlanChangedError,
    );
    expect(mocks.lease).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();

    mocks.consent.mockImplementation(() => {
      throw new Error("Consent changed");
    });
    await expect(applyClawUpdateForGateway(applyInput())).rejects.toThrow("Consent changed");
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("refuses a missing or stale skill warning receipt before touching the prior install", async () => {
    mocks.build.mockResolvedValue({
      ...built,
      projection: { ...projection, skillReviews: [skillReview] },
    });

    await expect(applyClawUpdateForGateway(applyInput())).rejects.toThrow(/review.*skill/i);
    await expect(
      applyClawUpdateForGateway({
        ...applyInput(),
        acknowledgeSkillWarnings: [
          {
            actionId: skillReview.actionId,
            ref: skillReview.ref,
            reviewToken: "sha256:old-review",
            acknowledgeRiskWarning: true,
          },
        ],
      }),
    ).rejects.toThrow(/skill trust state changed/i);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();

    const result = await applyClawUpdateForGateway({
      ...applyInput(),
      acknowledgeSkillWarnings: [
        {
          actionId: skillReview.actionId,
          ref: skillReview.ref,
          reviewToken: skillReview.reviewToken,
          acknowledgeRiskWarning: true,
        },
      ],
    });
    expect(result).toMatchObject({ status: "complete" });
    expect(mocks.apply).toHaveBeenCalledWith(
      plan,
      expect.anything(),
      expect.objectContaining({ skillConsent: expect.anything() }),
    );
  });

  it("rechecks the current plan under the lease before persisting", async () => {
    mocks.build.mockResolvedValueOnce(built).mockResolvedValueOnce({
      ...built,
      projection: { ...projection, planIntegrity: "sha256:changed" },
    });

    await expect(applyClawUpdateForGateway(applyInput())).rejects.toBeInstanceOf(
      ClawGatewayPlanChangedError,
    );
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("binds the reviewed effective access to the worker updater's final config write", async () => {
    await applyClawUpdateForGateway(applyInput());
    const options = mocks.apply.mock.calls[0]?.[2] as {
      assertReviewedConfig: (config: OpenClawConfig, desiredAgent: AgentConfig) => void;
    };
    const desiredAgent: AgentConfig = { id: "workflow-operator", name: "Workflow Operator v2" };
    expect(options.assertReviewedConfig).toBeTypeOf("function");
    expect(() =>
      options.assertReviewedConfig(
        { gateway: { controlUi: { experimental: { claws: true } } } },
        desiredAgent,
      ),
    ).not.toThrow();
    mocks.configuredAccess.mockReturnValueOnce({
      ...reviewedAccess,
      unresolved: ["runtime-tools", "memory-runtime"],
    });
    expect(() =>
      options.assertReviewedConfig({ tools: { deny: ["web_fetch"] } }, desiredAgent),
    ).toThrow("The effective Claw access changed since review");
    expect(mocks.configuredAccess).toHaveBeenCalledWith({
      config: { tools: { deny: ["web_fetch"] } },
      agentId: "workflow-operator",
      desiredAgent,
      operation: "update",
    });
  });

  it("rechecks the reviewed resulting access after the agent config commit", async () => {
    await applyClawUpdateForGateway(applyInput());
    const options = mocks.apply.mock.calls[0]?.[2] as {
      assertReviewedConfig: (
        config: OpenClawConfig,
        desiredAgent: AgentConfig,
        phase: "after-agent-commit",
      ) => void;
    };
    const desiredAgent: AgentConfig = { id: "workflow-operator", name: "Workflow Operator v2" };
    const effectiveConfig: OpenClawConfig = { tools: { deny: ["web_fetch"] } };

    mocks.configuredAccess.mockReturnValueOnce({
      ...reviewedAccess,
      current: { ...accessSnapshot, tools: { allowed: [], excluded: ["web_fetch"] } },
    });
    expect(() =>
      options.assertReviewedConfig(effectiveConfig, desiredAgent, "after-agent-commit"),
    ).toThrow("The effective Claw access changed since review");

    mocks.configuredAccess.mockReturnValueOnce({
      ...reviewedAccess,
      desired: { ...accessSnapshot, tools: { allowed: [], excluded: ["web_fetch"] } },
    });
    expect(() =>
      options.assertReviewedConfig(effectiveConfig, desiredAgent, "after-agent-commit"),
    ).toThrow("The effective Claw access changed since review");
  });

  it("passes the exact reviewed plugin acknowledgement to the worker updater", async () => {
    const review = {
      actionId: "plugin:@openclaw/workflow-operator-plugin",
      pluginId: "workflow-operator-plugin",
      ref: "@openclaw/workflow-operator-plugin",
      version: "1.2.0",
      ownerAction: "install" as const,
      declaredCapabilities: {
        channels: [],
        providers: [],
        tools: ["workflow.run"],
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
          allowConversationAccess: { effective: false },
        },
      },
      reviewToken: "sha256:plugin-review",
    };
    const acknowledgement = {
      actionId: review.actionId,
      pluginId: review.pluginId,
      reviewToken: review.reviewToken,
      capabilityGrants: review.capabilityGrants,
    };
    const pluginConsent = {
      confirmInstall: vi.fn(async () => true),
      onCapabilityConsent: vi.fn(),
    };
    mocks.build.mockResolvedValue({
      ...built,
      projection: { ...projection, pluginReviews: [review] },
    });
    mocks.consent.mockReturnValue(pluginConsent);
    const input = {
      ...applyInput(),
      acknowledgeCapabilities: [acknowledgement],
      reloadPlugins: vi.fn(),
    };

    expect(await applyClawUpdateForGateway(input)).toMatchObject({ status: "complete" });
    expect(mocks.consent).toHaveBeenCalledWith([review], [acknowledgement], expect.any(Function));
    expect(mocks.apply).toHaveBeenCalledWith(
      plan,
      expect.anything(),
      expect.objectContaining({ pluginConsent, reloadPlugins: input.reloadPlugins }),
    );
  });

  it("returns a partial outcome rather than a definite refusal after source persistence begins", async () => {
    mocks.plansMatch.mockReturnValue(false);
    const result = await applyClawUpdateForGateway(applyInput());

    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      agentId: "workflow-operator",
      status: "partial",
      error: { code: "update_outcome_uncertain" },
    });

    mocks.plansMatch.mockReturnValue(true);
    mocks.apply.mockRejectedValueOnce(new Error("worker mutation failed"));
    expect(await applyClawUpdateForGateway(applyInput())).toMatchObject({
      status: "partial",
      error: { code: "update_outcome_uncertain" },
    });
  });
});
