import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawHubSourceError } from "../../claws/clawhub-source.js";
import { ClawGatewayPlanChangedError } from "../../claws/gateway-add-apply.js";
import { ClawGatewayConsentError } from "../../claws/gateway-plugin-consent.js";
import { ClawSkillConsentError } from "../../claws/gateway-skill-consent.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { clawsAddHandlers } from "./claws-add.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const planClawAddForGateway = vi.hoisted(() => vi.fn());
const applyClawAddForGateway = vi.hoisted(() => vi.fn());
const listConfiguredMcpServers = vi.hoisted(() => vi.fn());
const readCurrentConfigForPolicyCheck = vi.hoisted(() => vi.fn());
const assertValidCronCreateDelivery = vi.hoisted(() => vi.fn());
const reloadManagedPlugin = vi.hoisted(() => vi.fn());
vi.mock("../../claws/gateway-add-plan.js", () => ({ planClawAddForGateway }));
vi.mock("../../claws/gateway-add-apply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../claws/gateway-add-apply.js")>()),
  applyClawAddForGateway,
}));
vi.mock("../../config/mcp-config.js", () => ({ listConfiguredMcpServers }));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  readCurrentConfigForPolicyCheck,
}));
vi.mock("../../cron/delivery-channel-validation.js", () => ({ assertValidCronCreateDelivery }));
vi.mock("../../plugins/management-mutations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/management-mutations.js")>()),
  reloadManagedPlugin,
}));

afterEach(() => {
  vi.clearAllMocks();
  readCurrentConfigForPolicyCheck.mockReset();
});

function callAddPlan(params: Record<string, unknown>, getRuntimeConfig: () => unknown) {
  const replies: Parameters<RespondFn>[] = [];
  return {
    replies,
    run: async () =>
      await expectDefined(
        clawsAddHandlers["claws.add.plan"],
        "claws.add.plan handler",
      )({
        req: { type: "req", id: "plan", method: "claws.add.plan" },
        params,
        respond: (...args) => replies.push(args),
        context: { getRuntimeConfig } as never,
        client: null,
        isWebchatConnect: () => false,
      }),
  };
}

function callAddApply(
  params: Record<string, unknown>,
  getRuntimeConfig: () => unknown,
  options: {
    hasCurrentClientAuthority?: () => boolean;
    client?: unknown;
    cron?: unknown;
    applyPluginLifecycleChange?: unknown;
  } = {},
) {
  const replies: Parameters<RespondFn>[] = [];
  return {
    replies,
    run: async () =>
      await expectDefined(
        clawsAddHandlers["claws.add.apply"],
        "claws.add.apply handler",
      )({
        req: { type: "req", id: "apply", method: "claws.add.apply" },
        params,
        respond: (...args) => replies.push(args),
        context: {
          getRuntimeConfig,
          cron: options.cron ?? { add: vi.fn(), list: vi.fn() },
          ...(options.applyPluginLifecycleChange
            ? { applyPluginLifecycleChange: options.applyPluginLifecycleChange }
            : {}),
        } as never,
        client:
          options.client === undefined
            ? ({ connect: { role: "operator", scopes: ["operator.admin"] } } as never)
            : (options.client as never),
        ...(options.hasCurrentClientAuthority
          ? { hasCurrentClientAuthority: options.hasCurrentClientAuthority }
          : {}),
        isWebchatConnect: () => false,
      }),
  };
}

describe("claws.add.plan Gateway method", () => {
  const source = { packageName: "@openclaw/workflow-operator", version: "1.0.0" };

  it("requires operator read scope and previews with Labs off", async () => {
    expect(coreGatewayHandlers["claws.add.plan"]).toBeDefined();
    expect(authorizeOperatorScopesForMethod("claws.add.plan", [])).toEqual({
      allowed: false,
      missingScope: "operator.read",
    });
    listConfiguredMcpServers.mockResolvedValue({ ok: true, mcpServers: {} });
    const plan = { operation: "add", planIntegrity: "sha256:reviewed" };
    planClawAddForGateway.mockResolvedValue(plan);
    const request = callAddPlan({ source }, () => ({}));
    await request.run();
    expect(request.replies).toEqual([[true, plan]]);
    expect(planClawAddForGateway).toHaveBeenCalledWith({
      source,
      config: {},
      sourceMcpServers: {},
    });
  });

  it("passes a verified-source plan to the browser without mutating installed state", async () => {
    const config = { gateway: { controlUi: { experimental: { claws: true } } } };
    const plan = {
      schemaVersion: "openclaw.clawsGatewayPlan.v1",
      operation: "add",
      planIntegrity: "sha256:reviewed",
      target: { agentId: "workflow-operator" },
      actions: [],
      capabilities: [],
      pluginReviews: [],
      blockers: [],
      riskAcknowledgementRequired: false,
    };
    listConfiguredMcpServers.mockResolvedValue({ ok: true, mcpServers: {} });
    planClawAddForGateway.mockResolvedValue(plan);
    const request = callAddPlan({ source }, () => config);
    await request.run();
    expect(planClawAddForGateway).toHaveBeenCalledWith({
      source,
      config,
      sourceMcpServers: {},
    });
    expect(request.replies).toEqual([[true, plan]]);
  });

  it("returns a preview after Labs is switched off mid-request", async () => {
    const on = { gateway: { controlUi: { experimental: { claws: true } } } };
    let calls = 0;
    listConfiguredMcpServers.mockResolvedValue({ ok: true, mcpServers: {} });
    const plan = { operation: "add", planIntegrity: "sha256:reviewed" };
    planClawAddForGateway.mockResolvedValue(plan);
    const request = callAddPlan({ source }, () => (calls++ === 0 ? on : {}));
    await request.run();
    expect(request.replies).toEqual([[true, plan]]);
  });
});

describe("claws.add.apply Gateway method", () => {
  const source = { packageName: "@openclaw/workflow-operator", version: "1.0.0" };
  const params = { source, planIntegrity: "sha256:reviewed", acknowledgeCapabilities: [] };
  const enabled = { gateway: { controlUi: { experimental: { claws: true } } } };
  const schedule = {
    name: "daily-brief",
    declarationKey: "claw:workflow-operator:daily-brief",
    owner: { agentId: "workflow-operator" },
    enabled: true,
    agentId: "workflow-operator",
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Summarize new work" },
    delivery: { mode: "none" },
  };

  it("requires operator admin scope and applies with Labs off", async () => {
    expect(coreGatewayHandlers["claws.add.apply"]).toBeDefined();
    expect(authorizeOperatorScopesForMethod("claws.add.apply", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    const result = { agentId: "workflow-operator", status: "complete" };
    applyClawAddForGateway.mockResolvedValue(result);
    const request = callAddApply(params, () => ({}));
    await request.run();
    expect(request.replies).toEqual([[true, result]]);
    expect(applyClawAddForGateway).toHaveBeenCalledOnce();
  });

  it("passes the reviewed coordinate to the canonical Add service", async () => {
    listConfiguredMcpServers.mockResolvedValue({ ok: true, mcpServers: {} });
    applyClawAddForGateway.mockImplementation(async (input) => {
      expect(await input.getPlanningContext()).toEqual({
        config: enabled,
        sourceMcpServers: {},
      });
      input.assertCurrent();
      return {
        agentId: "workflow-operator",
        status: "complete",
        readiness: { ready: true, requirements: [] },
      };
    });
    const request = callAddApply(params, () => enabled);
    await request.run();
    expect(applyClawAddForGateway).toHaveBeenCalledWith(
      expect.objectContaining({ source, planIntegrity: params.planIntegrity }),
    );
    expect(request.replies).toEqual([
      [
        true,
        {
          agentId: "workflow-operator",
          status: "complete",
          readiness: { ready: true, requirements: [] },
        },
      ],
    ]);
  });

  it("checks persisted config after agent commit even before the Gateway cache refreshes", async () => {
    const stale = { agents: { list: [] } };
    const committed = { agents: { list: [{ id: "workflow-operator" }] } };
    let persisted: typeof stale | typeof committed = stale;
    readCurrentConfigForPolicyCheck.mockImplementation(() => persisted);
    applyClawAddForGateway.mockImplementation(async (input) => {
      expect(input.getRuntimeConfig()).toEqual(stale);
      persisted = committed;
      expect(input.getRuntimeConfig()).toEqual(committed);
      return { agentId: "workflow-operator", status: "complete" };
    });

    const request = callAddApply(params, () => stale);
    await request.run();

    expect(readCurrentConfigForPolicyCheck).toHaveBeenCalledTimes(2);
    expect(request.replies).toEqual([[true, { agentId: "workflow-operator", status: "complete" }]]);
  });

  it("rejects revoked authority but continues when Labs changes during application", async () => {
    let authorized = true;
    applyClawAddForGateway.mockImplementation(async (input) => {
      authorized = false;
      input.assertCurrent();
    });
    const revoked = callAddApply(params, () => enabled, {
      hasCurrentClientAuthority: () => authorized,
    });
    await revoked.run();
    expect(revoked.replies[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });

    let labsEnabled = true;
    applyClawAddForGateway.mockImplementation(async (input) => {
      labsEnabled = false;
      input.assertCurrent();
      return { agentId: "workflow-operator", status: "complete" };
    });
    const switchedOff = callAddApply(params, () => (labsEnabled ? enabled : {}));
    await switchedOff.run();
    expect(switchedOff.replies).toEqual([
      [true, { agentId: "workflow-operator", status: "complete" }],
    ]);
  });

  it("returns review errors for a changed plan or missing plugin or skill acknowledgement", async () => {
    applyClawAddForGateway.mockRejectedValueOnce(new ClawGatewayPlanChangedError());
    const changed = callAddApply(params, () => enabled);
    await changed.run();
    expect(changed.replies[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });

    applyClawAddForGateway.mockRejectedValueOnce(
      new ClawGatewayConsentError("Plugin capabilities changed; review the Claw again."),
    );
    const consent = callAddApply(params, () => enabled);
    await consent.run();
    expect(consent.replies[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });

    applyClawAddForGateway.mockRejectedValueOnce(
      new ClawSkillConsentError("Review and acknowledge each skill trust warning again."),
    );
    const skillConsent = callAddApply(params, () => enabled);
    await skillConsent.run();
    expect(skillConsent.replies[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Review and acknowledge each skill trust warning again.",
    });
  });

  it("returns a definite rejection when ClawHub now requires trust acknowledgement", async () => {
    applyClawAddForGateway.mockRejectedValueOnce(
      new ClawHubSourceError(
        "clawhub_risk_acknowledgement_required",
        "Explicit acknowledgement is required for this ClawHub release.",
      ),
    );
    const request = callAddApply(params, () => enabled);
    await request.run();
    expect(request.replies[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Explicit acknowledgement is required for this ClawHub release.",
    });

    applyClawAddForGateway.mockRejectedValueOnce(
      new ClawHubSourceError("clawhub_artifact_unavailable", "ClawHub returned no Claw artifact."),
    );
    const unavailable = callAddApply(params, () => enabled);
    await unavailable.run();
    expect(unavailable.replies[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("validates Claw schedule delivery before calling the scheduler", async () => {
    const cron = { add: vi.fn(), list: vi.fn().mockResolvedValue([]) };
    const config = { cron: { failureAlert: { channel: "unconfigured" } } };
    assertValidCronCreateDelivery.mockRejectedValueOnce(new Error("Unconfigured failure route"));
    applyClawAddForGateway.mockImplementation(async (input) => {
      await input.cronGateway.add(schedule);
    });

    const request = callAddApply(params, () => config, { cron });
    await request.run();

    expect(assertValidCronCreateDelivery).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ declarationKey: schedule.declarationKey }),
    );
    expect(cron.add).not.toHaveBeenCalled();
    expect(request.replies[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rejects a declaration created after the Claw list check without mutating it", async () => {
    const cron = {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn(async (_input, options) => {
        options.matchesExisting({
          declarationKey: schedule.declarationKey,
          agentId: "workflow-operator",
          owner: { agentId: "workflow-operator" },
        });
        return { id: "intervening-job" };
      }),
    };
    assertValidCronCreateDelivery.mockResolvedValue(undefined);
    applyClawAddForGateway.mockImplementation(async (input) => {
      expect(await input.cronGateway.list("workflow-operator")).toEqual({ jobs: [] });
      await input.cronGateway.add(schedule);
    });

    const request = callAddApply(params, () => enabled, { cron });
    await request.run();

    expect(cron.add).toHaveBeenCalledOnce();
    expect(request.replies[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rechecks reviewed access at the scheduler's actual Add commit", async () => {
    let accessCurrent = true;
    const persisted = vi.fn();
    const cron = {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn(async (_input, options) => {
        accessCurrent = false;
        options.commitGuard();
        persisted();
        return { id: "new-job" };
      }),
    };
    assertValidCronCreateDelivery.mockResolvedValue(undefined);
    applyClawAddForGateway.mockImplementation(async (input) => {
      await input.cronGateway.add(schedule, {
        commitGuard: () => {
          if (!accessCurrent) {
            throw new Error("Reviewed Claw access changed before cron commit.");
          }
        },
      });
      return { agentId: "workflow-operator", status: "complete" };
    });

    const request = callAddApply(params, () => enabled, { cron });
    await request.run();

    expect(cron.add).toHaveBeenCalledOnce();
    expect(persisted).not.toHaveBeenCalled();
    expect(request.replies[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rechecks reviewed access at the plugin reload's persistent apply", async () => {
    let accessCurrent = true;
    const applied = vi.fn();
    reloadManagedPlugin.mockImplementation(async ({ beforePersistentApply }) => {
      accessCurrent = false;
      beforePersistentApply();
      applied();
      return { application: { status: "applied" } };
    });
    applyClawAddForGateway.mockImplementation(async (input) => {
      await input.reloadPlugins(["workflow-plugin"], {
        commitGuard: () => {
          if (!accessCurrent) {
            throw new Error("Reviewed Claw access changed before plugin reload.");
          }
        },
      });
      return { agentId: "workflow-operator", status: "complete" };
    });

    const request = callAddApply(params, () => enabled, {
      applyPluginLifecycleChange: vi.fn(),
    });
    await request.run();

    expect(reloadManagedPlugin).toHaveBeenCalledOnce();
    expect(applied).not.toHaveBeenCalled();
    expect(request.replies[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
  });
});
