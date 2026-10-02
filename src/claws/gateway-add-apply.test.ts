import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClawConfiguredAccess,
  ClawLifecyclePlanResult,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ClawAddMutationError } from "./add.js";
import type { ClawHubClawTrust } from "./clawhub-source.js";
import { applyClawAddForGateway, ClawGatewayPlanChangedError } from "./gateway-add-apply.js";
import type { ClawAddPlan, ClawReadResult } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  lease: vi.fn(),
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
const reviewedAccess: ClawConfiguredAccess = {
  coverage: "configuration-only",
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
  blockers: [],
  riskAcknowledgementRequired: false,
  configuredAccess: reviewedAccess,
  readiness: { ready: true, requirements: [] },
};
const config: OpenClawConfig = {};

function applyInput() {
  return {
    source: coordinate,
    planIntegrity: projected.planIntegrity,
    getPlanningContext: vi.fn(async () => ({ config, sourceMcpServers: {} })),
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
    const changedConfig: OpenClawConfig = { tools: { deny: ["web_fetch"] } };
    const input = applyInput();
    input.getPlanningContext
      .mockResolvedValueOnce({ config, sourceMcpServers: {} })
      .mockResolvedValueOnce({ config: changedConfig, sourceMcpServers: {} });
    mocks.project.mockImplementation(
      (_plan: ClawAddPlan, _root: string, _trust: ClawHubClawTrust, current: OpenClawConfig) =>
        current === config ? projected : { ...projected, planIntegrity: "sha256:changed" },
    );

    await expect(applyClawAddForGateway(input)).rejects.toBeInstanceOf(ClawGatewayPlanChangedError);
    expect(mocks.project).toHaveBeenNthCalledWith(2, plan, "/tmp/extracted", trust, changedConfig);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("checks effective access at the final config write without rejecting unrelated config edits", async () => {
    await applyClawAddForGateway(applyInput());
    const options = mocks.apply.mock.calls[0]?.[1] as {
      assertReviewedConfig: (config: OpenClawConfig) => void;
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
