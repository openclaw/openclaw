import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClawGatewayPlanChangedError } from "../../claws/gateway-add-apply.js";
import { ClawGatewayPlanError } from "../../claws/gateway-lifecycle-plan.js";
import { ClawGatewayConsentError } from "../../claws/gateway-plugin-consent.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { clawsLifecycleHandlers } from "./claws-lifecycle.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const planClawUpdateForGateway = vi.hoisted(() => vi.fn());
const planClawRemoveForGateway = vi.hoisted(() => vi.fn());
const applyClawUpdateForGateway = vi.hoisted(() => vi.fn());
const applyClawRemoveForGateway = vi.hoisted(() => vi.fn());
vi.mock("../../claws/gateway-lifecycle-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../claws/gateway-lifecycle-plan.js")>()),
  planClawUpdateForGateway,
  planClawRemoveForGateway,
}));
vi.mock("../../claws/gateway-update-apply.js", () => ({ applyClawUpdateForGateway }));
vi.mock("../../claws/gateway-remove-apply.js", () => ({ applyClawRemoveForGateway }));

afterEach(() => {
  vi.clearAllMocks();
});

function callPlan(
  method: "claws.update.plan" | "claws.remove.plan",
  params: unknown,
  getRuntimeConfig: () => unknown,
) {
  const replies: Parameters<RespondFn>[] = [];
  return {
    replies,
    run: async () =>
      await expectDefined(
        clawsLifecycleHandlers[method],
        `${method} handler`,
      )({
        req: { type: "req", id: "plan", method },
        params,
        respond: (...args) => replies.push(args),
        context: { getRuntimeConfig } as never,
        client: null,
        isWebchatConnect: () => false,
      }),
  };
}

function callUpdateApply(
  params: unknown,
  getRuntimeConfig: () => unknown,
  options: {
    hasCurrentClientAuthority?: () => boolean;
    sessionMutationCommitGuard?: () => void;
    cron?: unknown;
    client?: unknown;
  } = {},
) {
  const replies: Parameters<RespondFn>[] = [];
  return {
    replies,
    run: async () =>
      await expectDefined(
        clawsLifecycleHandlers["claws.update.apply"],
        "claws.update.apply handler",
      )({
        req: { type: "req", id: "apply", method: "claws.update.apply" },
        params,
        respond: (...args) => replies.push(args),
        context: {
          getRuntimeConfig,
          cron: options.cron ?? {
            add: vi.fn(),
            readJob: vi.fn(),
            list: vi.fn(async () => []),
            remove: vi.fn(),
          },
        } as never,
        client: (options.client ?? {
          connect: { role: "operator", scopes: ["operator.admin"] },
        }) as never,
        ...(options.hasCurrentClientAuthority
          ? { hasCurrentClientAuthority: options.hasCurrentClientAuthority }
          : {}),
        ...(options.sessionMutationCommitGuard
          ? { sessionMutationCommitGuard: options.sessionMutationCommitGuard }
          : {}),
        isWebchatConnect: () => false,
      }),
  };
}

function callRemoveApply(
  params: unknown,
  getRuntimeConfig: () => unknown,
  options: {
    hasCurrentClientAuthority?: () => boolean;
    client?: unknown;
  } = {},
) {
  const replies: Parameters<RespondFn>[] = [];
  return {
    replies,
    run: async () =>
      await expectDefined(
        clawsLifecycleHandlers["claws.remove.apply"],
        "claws.remove.apply handler",
      )({
        req: { type: "req", id: "remove", method: "claws.remove.apply" },
        params,
        respond: (...args) => replies.push(args),
        context: { getRuntimeConfig } as never,
        client: (options.client ?? {
          connect: { role: "operator", scopes: ["operator.admin"] },
        }) as never,
        ...(options.hasCurrentClientAuthority
          ? { hasCurrentClientAuthority: options.hasCurrentClientAuthority }
          : {}),
        isWebchatConnect: () => false,
      }),
  };
}

describe("Claw Update and Remove Gateway previews", () => {
  const enabled = { gateway: { controlUi: { experimental: { claws: true } } } };
  const source = { packageName: "@openclaw/workflow-operator", version: "1.0.1" };

  it("advertises read-scoped Update and Remove plans with Labs off", async () => {
    expect(coreGatewayHandlers["claws.update.plan"]).toBeDefined();
    expect(coreGatewayHandlers["claws.remove.plan"]).toBeDefined();
    expect(authorizeOperatorScopesForMethod("claws.update.plan", [])).toEqual({
      allowed: false,
      missingScope: "operator.read",
    });
    expect(authorizeOperatorScopesForMethod("claws.remove.plan", [])).toEqual({
      allowed: false,
      missingScope: "operator.read",
    });

    const updatePlan = { operation: "update", planIntegrity: "sha256:update" };
    planClawUpdateForGateway.mockResolvedValue(updatePlan);
    const update = callPlan("claws.update.plan", { agentId: "worker", source }, () => ({}));
    await update.run();
    expect(update.replies).toEqual([[true, updatePlan]]);
    expect(planClawUpdateForGateway).toHaveBeenCalledWith({
      agentId: "worker",
      source,
      config: {},
    });

    const plan = { operation: "remove", planIntegrity: "sha256:remove" };
    planClawRemoveForGateway.mockResolvedValue(plan);
    const remove = callPlan("claws.remove.plan", { agentId: "worker" }, () => ({}));
    await remove.run();
    expect(remove.replies).toEqual([[true, plan]]);
    expect(planClawRemoveForGateway).toHaveBeenCalledWith({
      agentId: "worker",
      config: {},
      monitorGateway: expect.objectContaining({ inspect: expect.any(Function) }),
    });
  });

  it("uses the canonical Update planner regardless of the Labs UI preference", async () => {
    const plan = { operation: "update", planIntegrity: "sha256:update" };
    planClawUpdateForGateway.mockResolvedValue(plan);
    const update = callPlan("claws.update.plan", { agentId: "worker", source }, () => enabled);
    await update.run();
    expect(planClawUpdateForGateway).toHaveBeenCalledWith({
      agentId: "worker",
      source,
      config: enabled,
    });
    expect(update.replies).toEqual([[true, plan]]);

    const switchedOff = callPlan("claws.update.plan", { agentId: "worker", source }, () => ({}));
    await switchedOff.run();
    expect(switchedOff.replies).toEqual([[true, plan]]);
  });

  it("maps invalid ownership and unavailable read-worker facts without leaking internals", async () => {
    planClawUpdateForGateway.mockRejectedValueOnce(
      new ClawGatewayPlanError("claw_update_source_mismatch", "This Claw cannot be updated."),
    );
    const mismatch = callPlan("claws.update.plan", { agentId: "worker", source }, () => enabled);
    await mismatch.run();
    expect(mismatch.replies[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });

    planClawRemoveForGateway.mockRejectedValueOnce(new Error("private state path"));
    const unavailable = callPlan("claws.remove.plan", { agentId: "worker" }, () => ({}));
    await unavailable.run();
    expect(unavailable.replies[0]?.[2]).toMatchObject({
      code: "UNAVAILABLE",
      message: "Claw lifecycle preview is unavailable. Review Gateway logs.",
    });
  });
});

describe("claws.remove.apply Gateway method", () => {
  const params = { agentId: "worker", planIntegrity: `sha256:${"a".repeat(64)}` };

  it("requires admin control-plane authority but permits removal with Labs off", async () => {
    expect(coreGatewayHandlers["claws.remove.apply"]).toBeDefined();
    expect(authorizeOperatorScopesForMethod("claws.remove.apply", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    const denied = callRemoveApply(params, () => ({}), {
      client: { connect: { role: "operator", scopes: ["operator.read"] } },
    });
    await denied.run();
    expect(denied.replies[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
    expect(applyClawRemoveForGateway).not.toHaveBeenCalled();

    const result = { agentId: "worker", status: "complete", agentRemoved: true };
    applyClawRemoveForGateway.mockResolvedValueOnce(result);
    const labsOff = callRemoveApply(params, () => ({}));
    await labsOff.run();
    expect(labsOff.replies).toEqual([[true, result]]);
    expect(applyClawRemoveForGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "worker",
        planIntegrity: params.planIntegrity,
        monitorGateway: expect.objectContaining({ inspect: expect.any(Function) }),
        assertCurrent: expect.any(Function),
      }),
    );
  });

  it("rejects stale review before effects and returns partial outcomes as successful responses", async () => {
    applyClawRemoveForGateway.mockRejectedValueOnce(new ClawGatewayPlanChangedError());
    const stale = callRemoveApply(params, () => ({}));
    await stale.run();
    expect(stale.replies[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });

    const partial = {
      agentId: "worker",
      status: "partial",
      agentRemoved: true,
      error: { code: "remove_partial", message: "Review Claws status." },
    };
    applyClawRemoveForGateway.mockResolvedValueOnce(partial);
    const incomplete = callRemoveApply(params, () => ({}));
    await incomplete.run();
    expect(incomplete.replies).toEqual([[true, partial]]);
  });

  it("checks live authority before starting a removal", async () => {
    const revoked = callRemoveApply(params, () => ({}), {
      hasCurrentClientAuthority: () => false,
    });
    await revoked.run();
    expect(revoked.replies[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
    expect(applyClawRemoveForGateway).not.toHaveBeenCalled();
  });
});

describe("claws.update.apply Gateway method", () => {
  const enabled = { gateway: { controlUi: { experimental: { claws: true } } } };
  const source = { packageName: "@openclaw/workflow-operator", version: "1.0.1" };
  const params = { agentId: "worker", source, planIntegrity: "sha256:reviewed" };

  it("requires admin control-plane authority but works with the Labs UI switch off", async () => {
    expect(coreGatewayHandlers["claws.update.apply"]).toBeDefined();
    expect(authorizeOperatorScopesForMethod("claws.update.apply", ["operator.read"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    const denied = callUpdateApply(params, () => ({}), {
      client: { connect: { role: "operator", scopes: ["operator.read"] } },
    });
    await denied.run();
    expect(denied.replies[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
    expect(applyClawUpdateForGateway).not.toHaveBeenCalled();

    const result = {
      agentId: "worker",
      status: "complete",
      readiness: { ready: true, requirements: [] },
    };
    applyClawUpdateForGateway.mockResolvedValue(result);
    const labsOff = callUpdateApply(params, () => ({}));
    await labsOff.run();
    expect(labsOff.replies).toEqual([[true, result]]);
  });

  it("passes exact review and a live authority guard to the canonical Update service", async () => {
    const result = {
      agentId: "worker",
      status: "complete",
      readiness: { ready: true, requirements: [] },
    };
    applyClawUpdateForGateway.mockImplementation(async (input) => {
      input.assertCurrent();
      expect(input.getRuntimeConfig()).toBe(enabled);
      return result;
    });
    const request = callUpdateApply(params, () => enabled);
    await request.run();
    expect(applyClawUpdateForGateway).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "worker", source, planIntegrity: params.planIntegrity }),
    );
    expect(request.replies).toEqual([[true, result]]);
  });

  it("passes the live guard through both cron add and remove commit boundaries", async () => {
    let authorized = true;
    const cron = {
      add: vi.fn(async () => ({ id: "job-1" })),
      readJob: vi.fn(async () => ({ id: "job-1" })),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => ({ removed: true })),
    };
    applyClawUpdateForGateway.mockImplementation(async (input) => {
      await input.cronGateway.add({
        name: "Nightly",
        declarationKey: "claw:worker:nightly",
        owner: { agentId: "worker" },
        enabled: true,
        agentId: "worker",
        schedule: { kind: "cron", expr: "0 8 * * *" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Review work" },
        delivery: { mode: "none" },
      });
      await input.cronGateway.get("job-1");
      await input.cronGateway.remove("job-1");
      return {
        agentId: "worker",
        status: "complete",
        readiness: { ready: true, requirements: [] },
      };
    });
    const request = callUpdateApply(params, () => enabled, {
      cron,
      hasCurrentClientAuthority: () => authorized,
    });
    await request.run();
    expect(request.replies[0]?.[0]).toBe(true);
    expect(cron.add).toHaveBeenCalledWith(
      expect.objectContaining({ declarationKey: "claw:worker:nightly" }),
      expect.objectContaining({ commitGuard: expect.any(Function) }),
    );
    expect(cron.remove).toHaveBeenCalledWith("job-1", {
      commitGuard: expect.any(Function),
    });
    authorized = false;
    expect(() => cron.add.mock.calls[0]?.[1]?.commitGuard()).toThrow();
    expect(() => cron.remove.mock.calls[0]?.[1]?.commitGuard()).toThrow();
  });

  it("rejects stale review before effects, but reports a post-effect partial result", async () => {
    applyClawUpdateForGateway.mockRejectedValueOnce(new ClawGatewayPlanChangedError());
    const changed = callUpdateApply(params, () => enabled);
    await changed.run();
    expect(changed.replies[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });

    applyClawUpdateForGateway.mockRejectedValueOnce(
      new ClawGatewayConsentError("Plugin capabilities changed; review the Claw again."),
    );
    const consent = callUpdateApply(params, () => enabled);
    await consent.run();
    expect(consent.replies[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });

    const partialResult = {
      agentId: "worker",
      status: "partial",
      readiness: { ready: false, requirements: [] },
    };
    applyClawUpdateForGateway.mockResolvedValueOnce(partialResult);
    const partial = callUpdateApply(params, () => enabled);
    await partial.run();
    expect(partial.replies).toEqual([[true, partialResult]]);
  });

  it("refuses revoked authority while allowing a Labs switch change during Update", async () => {
    let authorized = true;
    applyClawUpdateForGateway.mockImplementation(async (input) => {
      authorized = false;
      input.assertCurrent();
    });
    const revoked = callUpdateApply(params, () => enabled, {
      hasCurrentClientAuthority: () => authorized,
    });
    await revoked.run();
    expect(revoked.replies[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });

    let labsEnabled = true;
    applyClawUpdateForGateway.mockImplementation(async (input) => {
      labsEnabled = false;
      input.assertCurrent();
      return {
        agentId: "worker",
        status: "complete",
        readiness: { ready: true, requirements: [] },
      };
    });
    const labsOff = callUpdateApply(params, () => (labsEnabled ? enabled : {}));
    await labsOff.run();
    expect(labsOff.replies[0]?.[0]).toBe(true);
  });
});
