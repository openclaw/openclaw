import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TemplateConfiguredAccess,
  TemplateLifecyclePlanResult,
} from "../../packages/gateway-protocol/src/schema/templates.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { TemplateAddMutationError } from "./add.js";
import type { ClawHubTemplateTrust, withResolvedClawHubSource } from "./clawhub-source.js";
import {
  applyTemplateAddForGateway,
  TemplateGatewayPlanBlockedError,
  TemplateGatewayPlanChangedError,
} from "./gateway-add-apply.js";
import { TemplatesLabsDisabledError } from "./labs-gate.js";
import type { TemplateAddPlan, TemplateReadResult } from "./types.js";

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

// mock-isolation: Add receives a fixed Template source without contacting ClawHub.
vi.mock("./clawhub-source.js", () => ({ withResolvedClawHubSource: mocks.resolve }));
// mock-isolation: Lease acquisition is controlled to test Add admission boundaries.
vi.mock("../state/openclaw-state-lease.js", () => ({ withOpenClawStateLeaseAsync: mocks.lease }));
// mock-isolation: Plugin lease acquisition must be observable without a live owner.
vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLeaseAsync: mocks.pluginLease,
}));
vi.mock("../config/io.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.runtime.js")>()),
  withCurrentConfigPolicyReader: mocks.policyReader,
}));
// mock-isolation: The reviewed plan is a fixture so apply drift can be tested independently.
vi.mock("./gateway-add-plan.js", () => ({
  buildGatewayTemplateAddPlan: mocks.build,
  projectGatewayTemplateAddPlan: mocks.project,
}));
// mock-isolation: Source-root equality is varied without rebuilding source snapshots.
vi.mock("./gateway-plan-projection.js", () => ({ plansMatchAcrossSourceRoots: mocks.plansMatch }));
// mock-isolation: Access disclosure is fixed for the reviewed-plan scenarios.
vi.mock("./gateway-disclosure.js", () => ({
  projectTemplateConfiguredAccess: mocks.configuredAccess,
}));
// mock-isolation: Consent decisions are varied without invoking installer prompts.
vi.mock("./gateway-plugin-consent.js", () => ({ bindTemplatePluginInstallConsent: mocks.consent }));
// mock-isolation: The real Add mutates shared state; these tests observe handoff decisions.
vi.mock("./add-stateless.js", () => ({
  stageTemplateAddHostRequirementsStateless: async (plan: unknown, options: unknown) => ({
    kind: "ready",
    stageAgent: async () => ({
      kind: "ready",
      finish: async () => await mocks.apply(plan, options),
    }),
  }),
}));

const coordinate = { packageName: "@openclaw/workflow-operator", version: "1.0.0" };
const source = {
  manifest: { agent: { id: "workflow-operator" } },
  source: { packageRoot: "/tmp/extracted" },
} as Extract<TemplateReadResult, { ok: true }>;
const persistedSource = {
  source: { packageRoot: "/tmp/verified-cache" },
} as Extract<TemplateReadResult, { ok: true }>;
const trust: ClawHubTemplateTrust = {
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
} as unknown as TemplateAddPlan;
const reviewedDesired: NonNullable<TemplateConfiguredAccess["desired"]> = {
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
const reviewedAccess: TemplateConfiguredAccess = {
  coverage: "configuration-only",
  desired: reviewedDesired,
  unresolved: ["runtime-tools"],
};
const projected: TemplateLifecyclePlanResult = {
  schemaVersion: "openclaw.templatesGatewayPlan.v1",
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
const config: OpenClawConfig = { gateway: { controlUi: { experimental: { templates: true } } } };
const labsOff: OpenClawConfig = { gateway: { controlUi: { experimental: { templates: false } } } };

type ApplyInput = Parameters<typeof applyTemplateAddForGateway>[0];
function applyInput(overrides: Partial<ApplyInput> = {}) {
  return {
    source: coordinate,
    planIntegrity: projected.planIntegrity,
    getPlanningContext: vi.fn(async () => ({ config, sourceMcpServers: {} })),
    policyConfig: { configPath: "/tmp/openclaw.json", env: {} },
    assertCurrent: vi.fn(),
    ...overrides,
  };
}

const applyReviewed = () => applyTemplateAddForGateway(applyInput());

function usePolicy(getCurrentConfig: () => OpenClawConfig) {
  mocks.policyReader.mockImplementation(
    async (_options: unknown, run: (get: typeof getCurrentConfig) => Promise<unknown>) =>
      run(getCurrentConfig),
  );
}
function enterPluginLease(before: () => void = () => {}) {
  mocks.pluginLease.mockImplementation(
    async (
      _options: unknown,
      run: (lease: {
        databasePath: string;
        assertOwned: () => void;
        assertCurrent: () => void;
      }) => Promise<unknown>,
    ) => {
      before();
      return run({
        databasePath: "/tmp/state.sqlite",
        assertOwned: mocks.owned,
        assertCurrent: mocks.owned,
      });
    },
  );
}
function expectNoMutation() {
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
}
function expectNoAgentLease() {
  expect(
    mocks.lease.mock.calls.filter(([options]) => options.scope === "core:agent-deletion"),
  ).toHaveLength(0);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockImplementation(
    async (input: Parameters<typeof withResolvedClawHubSource>[0]) => ({
      value: await input.run(source, trust, mocks.persist),
      ...trust,
    }),
  );
  mocks.persist.mockResolvedValue(persistedSource);
  mocks.lease.mockImplementation(
    async (
      _options: unknown,
      _context: unknown,
      run: (lease: { assertOwned: () => void; assertCurrent: () => void }) => Promise<unknown>,
    ) => await run({ assertOwned: mocks.owned, assertCurrent: mocks.owned }),
  );
  enterPluginLease();
  usePolicy(() => config);
  mocks.build.mockResolvedValue(plan);
  mocks.project.mockReturnValue(projected);
  mocks.plansMatch.mockReturnValue(true);
  mocks.configuredAccess.mockReturnValue(reviewedAccess);
  mocks.apply.mockResolvedValue({ agent: { finalId: "workflow-operator" }, status: "complete" });
});

describe("Gateway Template Add application", () => {
  it("allocates distinct numbered agents for concurrent direct Adds", async () => {
    const entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {};
    const currentConfig: OpenClawConfig = { ...config, agents: { entries } };
    const pendingLeases = new Map<string, Promise<void>>();
    mocks.lease.mockImplementation(
      async (
        options: { scope: string; key: string },
        _context: unknown,
        run: (lease: { assertOwned: () => void; assertCurrent: () => void }) => Promise<unknown>,
      ) => {
        const key = `${options.scope}:${options.key}`;
        const previous = pendingLeases.get(key) ?? Promise.resolve();
        const { promise, resolve } = Promise.withResolvers<void>();
        pendingLeases.set(
          key,
          previous.then(() => promise),
        );
        await previous;
        try {
          return await run({ assertOwned: mocks.owned, assertCurrent: mocks.owned });
        } finally {
          resolve();
        }
      },
    );
    usePolicy(() => currentConfig);
    mocks.build.mockImplementation(async (_source: unknown, context: { agentId?: string }) => {
      const finalId =
        context.agentId ??
        (entries["workflow-operator"] ? "workflow-operator-2" : "workflow-operator");
      return {
        ...plan,
        agent: { finalId, config: { id: finalId } },
        blockers: entries[finalId] ? [{ code: "agent_id_collision" }] : [],
      };
    });
    mocks.project.mockImplementation((currentPlan: TemplateAddPlan) => ({
      ...projected,
      planIntegrity: `sha256:${currentPlan.agent.finalId}`,
      target: { agentId: currentPlan.agent.finalId },
      blockers: currentPlan.blockers,
    }));
    mocks.apply.mockImplementation(async (currentPlan: TemplateAddPlan) => {
      const agentId = currentPlan.agent.finalId;
      entries[agentId] = {};
      return { agent: { finalId: agentId }, status: "complete" };
    });
    const input = () =>
      applyInput({
        planIntegrity: undefined,
        getPlanningContext: async () => ({ config: currentConfig, sourceMcpServers: {} }),
      });

    const results = await Promise.all([
      applyTemplateAddForGateway(input()),
      applyTemplateAddForGateway(input()),
    ]);

    const allocated = ["workflow-operator", "workflow-operator-2"];
    expect(results.map((result) => result.agentId)).toEqual(allocated);
    expect(Object.keys(entries)).toEqual(allocated);
    expect(mocks.lease.mock.calls.map(([options]) => [options.scope, options.key])).toEqual([
      ["core:template-add-allocation", "workflow-operator"],
      ["core:template-add-allocation", "workflow-operator"],
      ["core:agent-deletion", "workflow-operator"],
      ["core:agent-deletion", "workflow-operator-2"],
    ]);
  });

  it("pins a direct install to the current plan and grants clean plugin consent", async () => {
    const { planIntegrity: _planIntegrity, ...input } = applyInput();
    await applyTemplateAddForGateway(input);
    expect(mocks.consent).toHaveBeenCalledWith(
      projected.pluginReviews,
      undefined,
      expect.any(Function),
      { allowCleanDirectInstall: true },
    );
    expect(mocks.apply).toHaveBeenCalled();
  });

  it("uses the canonical worker installer only after a sealed plan and persisted source match", async () => {
    const input = applyInput();
    const result = await applyTemplateAddForGateway(input);

    expect(result).toEqual({
      agentId: "workflow-operator",
      status: "complete",
      readiness: { ready: true, requirements: [] },
    });
    expect(input.getPlanningContext).toHaveBeenCalledTimes(3);
    expect(mocks.project).toHaveBeenNthCalledWith(1, plan, source, trust, config);
    expect(mocks.project).toHaveBeenNthCalledWith(2, plan, source, trust, config);
    expect(mocks.project).toHaveBeenNthCalledWith(3, plan, persistedSource, trust, config);
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

  it("rejects changed configured access before persisting the Template", async () => {
    const changedConfig: OpenClawConfig = { ...config, tools: { deny: ["web_fetch"] } };
    const input = applyInput();
    let onDisk = config;
    enterPluginLease(() => {
      onDisk = changedConfig;
    });
    usePolicy(() => onDisk);
    mocks.project.mockImplementation(
      (
        _plan: TemplateAddPlan,
        _source: typeof source,
        _trust: ClawHubTemplateTrust,
        current: OpenClawConfig,
      ) => (current === config ? projected : { ...projected, planIntegrity: "sha256:changed" }),
    );

    await expect(applyTemplateAddForGateway(input)).rejects.toBeInstanceOf(
      TemplateGatewayPlanChangedError,
    );
    expect(mocks.project).toHaveBeenNthCalledWith(2, plan, source, trust, changedConfig);
    expectNoMutation();
  });

  it.each([
    ["current", "blocker"],
    ["persisted", "blocker"],
    ["persisted", "integrity"],
  ] as const)("rejects %s replan %s drift", async (phase, drift) => {
    const changed: TemplateLifecyclePlanResult =
      drift === "integrity"
        ? { ...projected, planIntegrity: "sha256:changed" }
        : {
            ...projected,
            blockers: [
              {
                code: "effect_disclosure_unavailable",
                path: "$.actions[0]",
                message: "The Template effect cannot be reviewed safely.",
              },
            ],
          };
    mocks.project
      .mockReturnValueOnce(projected)
      .mockReturnValueOnce(phase === "current" ? changed : projected)
      .mockReturnValueOnce(phase === "persisted" ? changed : projected);

    await expect(applyReviewed()).rejects.toBeInstanceOf(TemplateGatewayPlanChangedError);
    expect(plan.blockers).toEqual([]);
    expect(mocks.persist).toHaveBeenCalledTimes(phase === "current" ? 0 : 1);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("checks full access before config commit and actual agent access afterward", async () => {
    await applyReviewed();
    const { assertReviewedConfig } = mocks.apply.mock.calls[0]![1] as {
      assertReviewedConfig: (config: OpenClawConfig, phase?: "after-agent-commit") => void;
    };
    expect(assertReviewedConfig).toBeTypeOf("function");
    expect(() => assertReviewedConfig(config)).not.toThrow();
    mocks.configuredAccess.mockReturnValueOnce({
      ...reviewedAccess,
      unresolved: ["runtime-tools", "memory-runtime"],
    });
    expect(() => assertReviewedConfig({ tools: { deny: ["web_fetch"] } })).toThrow(
      TemplateAddMutationError,
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
    expect(() => assertReviewedConfig(committedConfig, "after-agent-commit")).not.toThrow();
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
    expect(() => assertReviewedConfig(committedConfig, "after-agent-commit")).toThrow(
      TemplateAddMutationError,
    );
  });

  it("pins current policy only after the agent and plugin leases", async () => {
    const input = applyInput();
    await applyTemplateAddForGateway(input);

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
    enterPluginLease(() => {
      onDisk = labsOff;
    });
    usePolicy(() => onDisk);

    await expect(applyReviewed()).rejects.toBeInstanceOf(TemplatesLabsDisabledError);
    expectNoMutation();
  });

  it("rechecks Labs at a later mutation effect boundary", async () => {
    let onDisk = config;
    usePolicy(() => onDisk);
    mocks.apply.mockImplementation(
      async (_plan: TemplateAddPlan, options: { getCurrentConfig: () => OpenClawConfig }) => {
        onDisk = labsOff;
        options.getCurrentConfig();
      },
    );

    await expect(applyReviewed()).rejects.toBeInstanceOf(TemplatesLabsDisabledError);
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });

  it("does not acquire a mutation lease when the reviewed plan changed", async () => {
    mocks.project.mockReturnValue({ ...projected, planIntegrity: "sha256:changed" });

    await expect(applyReviewed()).rejects.toBeInstanceOf(TemplateGatewayPlanChangedError);
    expectNoAgentLease();
    expectNoMutation();
  });

  it("explains an unavailable required skill before mutating anything", async () => {
    const missingSkill = { code: "skill_preflight_failed", path: "$.packages[0]" };
    mocks.build.mockResolvedValue({
      ...plan,
      blockers: [{ ...missingSkill, message: "Skill not found" }],
    });
    mocks.project.mockReturnValue({
      ...projected,
      blockers: [
        {
          ...missingSkill,
          message: "Resolve this OpenClaw state conflict before continuing.",
        },
      ],
    });

    await expect(applyReviewed()).rejects.toThrow(TemplateGatewayPlanBlockedError);
    await expect(applyReviewed()).rejects.toThrow("A required skill is unavailable from ClawHub");
    expectNoAgentLease();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("rejects a sibling workspace that changed after review before persisting", async () => {
    const reviewedWorkspace = "/tmp/state/workspace-workflow-operator-2";
    const currentWorkspace = "/tmp/state/workspace-workflow-operator-3";
    mocks.build.mockResolvedValue({
      ...plan,
      agent: {
        ...plan.agent,
        workspace: currentWorkspace,
        config: { ...plan.agent.config, workspace: currentWorkspace },
      },
    });
    mocks.project.mockImplementation((current: TemplateAddPlan) => ({
      ...projected,
      target: { ...projected.target, workspace: current.agent.workspace },
      planIntegrity:
        current.agent.workspace === reviewedWorkspace
          ? projected.planIntegrity
          : "sha256:workspace-changed",
    }));

    await expect(applyReviewed()).rejects.toBeInstanceOf(TemplateGatewayPlanChangedError);
    expectNoAgentLease();
    expectNoMutation();
  });

  it.each([
    ["plugin activation", "Gateway plugin activation is unavailable"],
    ["skill review", /review.*skill/i],
    ["cron authority", "Gateway schedule installation is unavailable"],
  ] as const)("requires %s before persisting the Template", async (requirement, error) => {
    if (requirement === "cron authority") {
      mocks.build.mockResolvedValue({
        ...plan,
        actions: [{ kind: "cronJob", id: "nightly", blocked: false }],
      });
    } else {
      mocks.project.mockReturnValue({
        ...projected,
        ...(requirement === "skill review"
          ? { skillReviews: [skillReview] }
          : { pluginReviews: [{ ownerAction: "install", pluginId: "workflow-operator" }] }),
      });
    }
    await expect(applyReviewed()).rejects.toThrow(error);
    expectNoMutation();
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
      applyTemplateAddForGateway({
        ...input,
        acknowledgeSkillWarnings: [{ ...acknowledgement, reviewToken: "sha256:stale" }],
      }),
    ).rejects.toThrow(/skill trust state changed/i);
    expectNoMutation();

    await expect(
      applyTemplateAddForGateway({ ...input, acknowledgeSkillWarnings: [acknowledgement] }),
    ).resolves.toMatchObject({ status: "complete" });
    const { skillConsent } = mocks.apply.mock.calls[0]![1] as {
      skillConsent: { assertApproved: (review: typeof skillReview) => void };
    };
    expect(skillConsent).toBeDefined();
    expect(() => skillConsent.assertApproved(skillReview)).not.toThrow();
    expect(() => skillConsent.assertApproved({ ...skillReview, riskWarning: "changed" })).toThrow(
      /skill trust state changed/i,
    );
  });
});
