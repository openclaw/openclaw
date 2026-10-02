import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClawConfiguredAccess,
  ClawLifecyclePlanResult,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ClawAddMutationError } from "./add.js";
import type { ClawHubClawTrust } from "./clawhub-source.js";
import { applyClawAddForGateway, ClawGatewayPlanChangedError } from "./gateway-add-apply.js";
import { ClawsLabsDisabledError } from "./labs-gate.js";
import type { ClawAddPlan, ClawReadResult } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  lease: vi.fn(),
  pluginLease: vi.fn(),
  policyReader: vi.fn(),
  build: vi.fn(),
  project: vi.fn(),
  plansMatch: vi.fn(),
  consent: vi.fn(),
  apply: vi.fn(),
  persist: vi.fn(),
  owned: vi.fn(),
  configuredAccess: vi.fn(),
}));

vi.mock("./clawhub-source.js", () => ({ withResolvedClawHubSource: mocks.resolve }));
vi.mock("../state/openclaw-state-lease.js", () => ({ withOpenClawStateLease: mocks.lease }));
vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: mocks.pluginLease,
}));
vi.mock("../config/io.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.runtime.js")>()),
  withCurrentConfigPolicyReader: mocks.policyReader,
}));
vi.mock("./gateway-add-plan.js", () => ({
  buildGatewayClawAddPlan: mocks.build,
  projectGatewayClawAddPlan: mocks.project,
}));
vi.mock("./gateway-plan-projection.js", () => ({ plansMatchAcrossSourceRoots: mocks.plansMatch }));
vi.mock("./gateway-disclosure.js", () => ({ projectClawConfiguredAccess: mocks.configuredAccess }));
vi.mock("./gateway-plugin-consent.js", () => ({ bindClawPluginInstallConsent: mocks.consent }));
vi.mock("./add.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./add.js")>()),
  applyClawAddPlan: mocks.apply,
}));

const coordinate = { packageName: "@openclaw/workflow-operator", version: "1.0.0" };
const source = {
  source: { packageRoot: "/tmp/extracted" },
} as Extract<ClawReadResult, { ok: true }>;
const persistedSource = {
  source: { packageRoot: "/tmp/verified-cache" },
} as Extract<ClawReadResult, { ok: true }>;
const trust: ClawHubClawTrust = {
  riskAcknowledgementRequired: false,
  trustRecord: {
    clawhubTrustDisposition: "clean",
    clawhubTrustCheckedAt: "2026-09-30T00:00:00.000Z",
  },
};
const plan = {
  agent: { finalId: "workflow-operator", config: { id: "workflow-operator" } },
  blockers: [],
  actions: [],
  planIntegrity: "sha256:canonical",
} as unknown as ClawAddPlan;
const reviewedDesired: NonNullable<ClawConfiguredAccess["desired"]> = {
  tools: { allowed: ["read"], excluded: ["exec"], explicitAllow: ["read"], explicitDeny: ["exec"] },
  sandbox: { mode: "all", scope: "session", workspaceAccess: "rw", backend: "docker" },
  filesystem: { workspaceOnly: true },
  heartbeat: { enabled: false, intervalMs: null },
  memorySearch: { state: "disabled" },
  subagentTargets: {
    allowedAgentIds: ["workflow-operator"],
    allowAnyConfiguredAgent: false,
    implicitSelfAllowed: true,
    requireAgentId: false,
  },
};
const reviewedAccess: ClawConfiguredAccess = {
  coverage: "configuration-only",
  desired: reviewedDesired,
  unresolved: ["runtime-tools"],
};
const projected: ClawLifecyclePlanResult = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "add",
  planIntegrity: "sha256:reviewed",
  target: { agentId: "workflow-operator" },
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
  version: "1.0.0",
  integrity: "sha256:artifact",
  riskWarning: "This skill requires review before installation.",
  reviewToken: "sha256:skill-review",
};
const config: OpenClawConfig = { gateway: { controlUi: { experimental: { claws: true } } } };
const labsOff: OpenClawConfig = { gateway: { controlUi: { experimental: { claws: false } } } };

function applyInput() {
  return {
    source: coordinate,
    planIntegrity: projected.planIntegrity,
    getPlanningContext: vi.fn(async () => ({ config, sourceMcpServers: {} })),
    policyConfig: { configPath: "/tmp/openclaw.json", env: {} },
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
  mocks.pluginLease.mockImplementation(
    async (
      _options: unknown,
      run: (lease: { databasePath: string; assertOwned: () => void }) => Promise<unknown>,
    ) => await run({ databasePath: "/tmp/state.sqlite", assertOwned: mocks.owned }),
  );
  mocks.policyReader.mockImplementation(
    async (_options: unknown, run: (getCurrentConfig: () => OpenClawConfig) => Promise<unknown>) =>
      await run(() => config),
  );
  mocks.build.mockResolvedValue(plan);
  mocks.project.mockReturnValue(projected);
  mocks.plansMatch.mockReturnValue(true);
  mocks.configuredAccess.mockReturnValue(reviewedAccess);
  mocks.apply.mockResolvedValue({ agent: { finalId: "workflow-operator" }, status: "complete" });
});

describe("Gateway Claw Add application", () => {
  it("uses the canonical worker installer only after a sealed plan and persisted source match", async () => {
    const input = applyInput();
    const result = await applyClawAddForGateway(input);

    expect(result).toEqual({
      agentId: "workflow-operator",
      status: "complete",
      readiness: { ready: true, requirements: [] },
    });
    expect(input.getPlanningContext).toHaveBeenCalledTimes(3);
    expect(mocks.project).toHaveBeenNthCalledWith(1, plan, "/tmp/extracted", trust, config);
    expect(mocks.project).toHaveBeenNthCalledWith(2, plan, "/tmp/extracted", trust, config);
    expect(mocks.project).toHaveBeenNthCalledWith(3, plan, "/tmp/verified-cache", trust, config);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.plansMatch).toHaveBeenCalledTimes(1);
    expect(mocks.apply).toHaveBeenCalledWith(
      plan,
      expect.objectContaining({
        stateMode: "worker",
        config,
        consentPlanIntegrity: plan.planIntegrity,
        assertCurrent: expect.any(Function),
      }),
    );
    expect(mocks.owned).toHaveBeenCalled();
  });

  it("rejects changed configured access before persisting the Claw", async () => {
    const changedConfig: OpenClawConfig = { ...config, tools: { deny: ["web_fetch"] } };
    const input = applyInput();
    let onDisk = config;
    mocks.pluginLease.mockImplementation(
      async (
        _options: unknown,
        run: (lease: { databasePath: string; assertOwned: () => void }) => Promise<unknown>,
      ) => {
        onDisk = changedConfig;
        return await run({ databasePath: "/tmp/state.sqlite", assertOwned: mocks.owned });
      },
    );
    mocks.policyReader.mockImplementation(
      async (
        _options: unknown,
        run: (getCurrentConfig: () => OpenClawConfig) => Promise<unknown>,
      ) => await run(() => onDisk),
    );
    mocks.project.mockImplementation(
      (_plan: ClawAddPlan, _root: string, _trust: ClawHubClawTrust, current: OpenClawConfig) =>
        current === config ? projected : { ...projected, planIntegrity: "sha256:changed" },
    );

    await expect(applyClawAddForGateway(input)).rejects.toBeInstanceOf(ClawGatewayPlanChangedError);
    expect(mocks.project).toHaveBeenNthCalledWith(2, plan, "/tmp/extracted", trust, changedConfig);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it.each(["current", "persisted"] as const)(
    "rejects a projection-only blocker at the %s replan",
    async (phase) => {
      const blockedProjection: ClawLifecyclePlanResult = {
        ...projected,
        blockers: [
          {
            code: "effect_disclosure_unavailable",
            path: "$.actions[0]",
            message: "The Claw effect cannot be reviewed safely.",
          },
        ],
      };
      mocks.project
        .mockReturnValueOnce(projected)
        .mockReturnValueOnce(phase === "current" ? blockedProjection : projected)
        .mockReturnValueOnce(phase === "persisted" ? blockedProjection : projected);

      await expect(applyClawAddForGateway(applyInput())).rejects.toBeInstanceOf(
        ClawGatewayPlanChangedError,
      );
      expect(plan.blockers).toEqual([]);
      expect(mocks.persist).toHaveBeenCalledTimes(phase === "current" ? 0 : 1);
      expect(mocks.apply).not.toHaveBeenCalled();
    },
  );

  it("checks full access before config commit and actual agent access afterward", async () => {
    await applyClawAddForGateway(applyInput());
    const options = mocks.apply.mock.calls[0]?.[1] as {
      assertReviewedConfig: (config: OpenClawConfig, phase?: "after-agent-commit") => void;
    };
    expect(options.assertReviewedConfig).toBeTypeOf("function");
    expect(() =>
      options.assertReviewedConfig({ gateway: { controlUi: { experimental: { claws: true } } } }),
    ).not.toThrow();
    mocks.configuredAccess.mockReturnValueOnce({
      ...reviewedAccess,
      unresolved: ["runtime-tools", "memory-runtime"],
    });
    expect(() => options.assertReviewedConfig({ tools: { deny: ["web_fetch"] } })).toThrow(
      ClawAddMutationError,
    );
    expect(mocks.configuredAccess).toHaveBeenCalledWith({
      config: { tools: { deny: ["web_fetch"] } },
      agentId: "workflow-operator",
      desiredAgent: plan.agent.config,
      operation: "add",
    });

    const committedConfig: OpenClawConfig = {
      agents: { entries: { "workflow-operator": {} } },
    };
    mocks.configuredAccess.mockReturnValueOnce({
      ...reviewedAccess,
      current: reviewedDesired,
    });
    expect(() => options.assertReviewedConfig(committedConfig, "after-agent-commit")).not.toThrow();
    expect(mocks.configuredAccess).toHaveBeenLastCalledWith({
      config: committedConfig,
      agentId: "workflow-operator",
      desiredAgent: plan.agent.config,
      operation: "update",
    });
    mocks.configuredAccess.mockReturnValueOnce({
      ...reviewedAccess,
      current: { ...reviewedDesired, filesystem: { workspaceOnly: false } },
    });
    expect(() => options.assertReviewedConfig(committedConfig, "after-agent-commit")).toThrow(
      ClawAddMutationError,
    );
  });

  it("pins current policy only after the agent and plugin leases", async () => {
    const input = applyInput();
    await applyClawAddForGateway(input);

    expect(mocks.lease.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pluginLease.mock.invocationCallOrder[0]!,
    );
    expect(mocks.pluginLease.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.policyReader.mock.invocationCallOrder[0]!,
    );
    expect(mocks.policyReader).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: input.policyConfig.configPath,
        lease: expect.objectContaining({ databasePath: "/tmp/state.sqlite" }),
      }),
      expect.any(Function),
    );
    expect(mocks.apply).toHaveBeenCalledWith(
      plan,
      expect.objectContaining({ getCurrentConfig: expect.any(Function) }),
    );
    const options = mocks.apply.mock.calls[0]?.[1] as { getCurrentConfig: () => OpenClawConfig };
    expect(options.getCurrentConfig()).toBe(config);
  });

  it("refuses Add when Labs turns off while waiting for the mutation lease", async () => {
    let onDisk = config;
    mocks.pluginLease.mockImplementation(
      async (
        _options: unknown,
        run: (lease: { databasePath: string; assertOwned: () => void }) => Promise<unknown>,
      ) => {
        onDisk = labsOff;
        return await run({ databasePath: "/tmp/state.sqlite", assertOwned: mocks.owned });
      },
    );
    mocks.policyReader.mockImplementation(
      async (
        _options: unknown,
        run: (getCurrentConfig: () => OpenClawConfig) => Promise<unknown>,
      ) => await run(() => onDisk),
    );

    await expect(applyClawAddForGateway(applyInput())).rejects.toBeInstanceOf(
      ClawsLabsDisabledError,
    );
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("rechecks Labs at a later mutation effect boundary", async () => {
    let onDisk = config;
    mocks.policyReader.mockImplementation(
      async (
        _options: unknown,
        run: (getCurrentConfig: () => OpenClawConfig) => Promise<unknown>,
      ) => await run(() => onDisk),
    );
    mocks.apply.mockImplementation(
      async (_plan: ClawAddPlan, options: { getCurrentConfig: () => OpenClawConfig }) => {
        onDisk = labsOff;
        options.getCurrentConfig();
      },
    );

    await expect(applyClawAddForGateway(applyInput())).rejects.toBeInstanceOf(
      ClawsLabsDisabledError,
    );
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });

  it("does not acquire a mutation lease when the reviewed plan changed", async () => {
    mocks.project.mockReturnValue({ ...projected, planIntegrity: "sha256:changed" });

    await expect(applyClawAddForGateway(applyInput())).rejects.toBeInstanceOf(
      ClawGatewayPlanChangedError,
    );
    expect(mocks.lease).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("stops when the final persisted artifact produces different reviewed facts", async () => {
    mocks.project
      .mockReturnValueOnce(projected)
      .mockReturnValueOnce(projected)
      .mockReturnValueOnce({ ...projected, planIntegrity: "sha256:changed" });

    await expect(applyClawAddForGateway(applyInput())).rejects.toBeInstanceOf(
      ClawGatewayPlanChangedError,
    );
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("requires live plugin activation before persisting a plugin-bearing Claw", async () => {
    mocks.project.mockReturnValue({
      ...projected,
      pluginReviews: [{ ownerAction: "install", pluginId: "workflow-operator" }],
    });

    await expect(applyClawAddForGateway(applyInput())).rejects.toThrow(
      "Gateway plugin activation is unavailable",
    );
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("requires review of a warned skill before persisting the Claw", async () => {
    mocks.project.mockReturnValue({ ...projected, skillReviews: [skillReview] });

    await expect(applyClawAddForGateway(applyInput())).rejects.toThrow(/review.*skill/i);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("rejects a stale skill warning receipt and passes an exact one to the installer", async () => {
    mocks.project.mockReturnValue({ ...projected, skillReviews: [skillReview] });
    const input = applyInput();
    const acknowledgement = {
      actionId: skillReview.actionId,
      ref: skillReview.ref,
      reviewToken: skillReview.reviewToken,
      acknowledgeRiskWarning: true as const,
    };

    await expect(
      applyClawAddForGateway({
        ...input,
        acknowledgeSkillWarnings: [{ ...acknowledgement, reviewToken: "sha256:stale" }],
      }),
    ).rejects.toThrow(/skill trust state changed/i);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();

    await expect(
      applyClawAddForGateway({ ...input, acknowledgeSkillWarnings: [acknowledgement] }),
    ).resolves.toMatchObject({ status: "complete" });
    const installOptions = mocks.apply.mock.calls[0]?.[1] as {
      skillConsent: { assertApproved: (review: typeof skillReview) => void };
    };
    expect(installOptions.skillConsent).toBeDefined();
    expect(() => installOptions.skillConsent.assertApproved(skillReview)).not.toThrow();
    expect(() =>
      installOptions.skillConsent.assertApproved({ ...skillReview, riskWarning: "changed" }),
    ).toThrow(/skill trust state changed/i);
  });

  it("requires Gateway cron authority before persisting a scheduled Claw", async () => {
    mocks.build.mockResolvedValue({
      ...plan,
      actions: [{ kind: "cronJob", id: "nightly", blocked: false }],
    });

    await expect(applyClawAddForGateway(applyInput())).rejects.toThrow(
      "Gateway schedule installation is unavailable",
    );
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
