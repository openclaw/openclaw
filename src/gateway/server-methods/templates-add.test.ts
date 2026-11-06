import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import type { CronJob } from "../../cron/types.js";
import { ClawHubSourceError } from "../../templates/clawhub-source.js";
import {
  TemplateGatewayPlanBlockedError,
  TemplateGatewayPlanChangedError,
} from "../../templates/gateway-add-apply.js";
import { TemplateGatewayConsentError } from "../../templates/gateway-plugin-consent.js";
import { TemplateSkillConsentError } from "../../templates/gateway-skill-consent.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import { templatesAddHandlers } from "./templates-add.js";
import type { RespondFn } from "./types.js";

const planAdd = vi.hoisted(() => vi.fn());
const applyAdd = vi.hoisted(() => vi.fn());
const listMcp = vi.hoisted(() => vi.fn());
const readPolicySync = vi.hoisted(() => vi.fn());
const readPolicy = vi.hoisted(() => vi.fn());
const validateDelivery = vi.hoisted(() => vi.fn());
const reloadPlugin = vi.hoisted(() => vi.fn());
const deleteAgent = vi.hoisted(() => vi.fn());
vi.mock("../../templates/gateway-add-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../templates/gateway-add-plan.js")>()),
  planTemplateAddForGateway: planAdd,
}));
vi.mock("../../templates/gateway-add-apply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../templates/gateway-add-apply.js")>()),
  applyTemplateAddForGateway: applyAdd,
}));
vi.mock("../../config/mcp-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/mcp-config.js")>()),
  listConfiguredMcpServers: listMcp,
}));
vi.mock("../../config/io.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.runtime.js")>()),
  readCurrentConfigForPolicyCheck: readPolicySync,
  readCurrentConfigForPolicyCheckAsync: readPolicy,
}));
vi.mock("../../cron/delivery-channel-validation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cron/delivery-channel-validation.js")>()),
  assertValidCronCreateDelivery: validateDelivery,
}));
vi.mock("../../plugins/management-mutations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/management-mutations.js")>()),
  reloadManagedPlugin: reloadPlugin,
}));
vi.mock("./agents-config-mutations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agents-config-mutations.js")>()),
  deleteAgentConfigEntry: deleteAgent,
}));

const agentId = "workflow-operator";
const enabled = { gateway: { controlUi: { experimental: { templates: true } } } };
const source = { packageName: "@openclaw/workflow-operator", version: "1.0.0" };
const complete = { agentId, status: "complete" };
const ready = { ...complete, readiness: { ready: true, requirements: [] } };
const onDisk = { ...enabled, agents: { list: [{ id: agentId }] } };

beforeEach(() => {
  listMcp.mockResolvedValue({ ok: true, mcpServers: {} });
  readPolicy.mockResolvedValue(enabled);
});

afterEach(() => vi.clearAllMocks());

const params = { source, planIntegrity: "sha256:reviewed", acknowledgeCapabilities: [] };
const plan = { operation: "add", planIntegrity: "sha256:reviewed", target: { agentId } };

function makeCron<T extends object>(overrides: T) {
  return { add: vi.fn(), list: vi.fn().mockResolvedValue([]), ...overrides };
}

async function callAdd(
  operation: "plan" | "apply",
  getRuntimeConfig: () => unknown = () => enabled,
  options: {
    hasCurrentClientAuthority?: () => boolean;
    cron?: unknown;
    applyPluginLifecycleChange?: unknown;
  } = {},
) {
  const { hasCurrentClientAuthority, ...runtime } = options;
  const method = `templates.add.${operation}`;
  const respond = vi.fn<RespondFn>();
  const handler = expectDefined(templatesAddHandlers[method], method);
  await handler({
    req: { type: "req", id: "add", method },
    params: operation === "plan" ? { source } : params,
    respond,
    context: { getRuntimeConfig, ...runtime } as never,
    client:
      operation === "apply"
        ? ({ connect: { role: "operator", scopes: ["operator.admin"] } } as never)
        : null,
    hasCurrentClientAuthority,
    isWebchatConnect: () => false,
  });
  return respond.mock.calls;
}

async function applyThrough(
  run: (
    input: Parameters<
      typeof import("../../templates/gateway-add-apply.js").applyTemplateAddForGateway
    >[0],
  ) => unknown,
  options: Parameters<typeof callAdd>[2] = {},
  config = enabled,
) {
  applyAdd.mockImplementation(async (input) => {
    await run(input);
    return complete;
  });
  return callAdd("apply", () => config, options);
}

it.each(["plan", "apply"] as const)(
  "templates.add.%s requires its scope and Labs",
  async (operation) => {
    const method = `templates.add.${operation}`;
    expect(coreGatewayHandlers[method]).toBeDefined();
    expect(
      authorizeOperatorScopesForMethod(method, operation === "plan" ? [] : ["operator.read"]),
    ).toEqual({
      allowed: false,
      missingScope: operation === "plan" ? "operator.read" : "operator.admin",
    });
    const request = await callAdd(operation, () => ({}));
    expect(request[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
    expect(operation === "plan" ? planAdd : applyAdd).not.toHaveBeenCalled();
  },
);

it("plans from the persisted roster, not a stale Gateway cache", async () => {
  readPolicy.mockResolvedValue(onDisk);
  planAdd.mockResolvedValue(plan);
  const request = await callAdd("plan");
  expect(planAdd).toHaveBeenCalledWith({
    source,
    config: onDisk,
    sourceMcpServers: {},
  });
  expect(request).toEqual([[true, plan]]);
});

it("drops a preview if Labs is switched off mid-request", async () => {
  let calls = 0;
  planAdd.mockResolvedValue(plan);
  const request = await callAdd("plan", () => (calls++ === 0 ? enabled : {}));
  expect(request[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
});
const schedule = {
  name: "daily-brief",
  declarationKey: "template:workflow-operator:daily-brief",
  owner: { agentId },
  enabled: true,
  agentId,
  schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Summarize new work" },
  delivery: { mode: "none" },
} satisfies Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state">;

it("applies the reviewed coordinate against the persisted roster", async () => {
  readPolicy.mockResolvedValue(onDisk);
  applyAdd.mockImplementation(async (input) => {
    expect(await input.getPlanningContext()).toEqual({
      config: onDisk,
      sourceMcpServers: {},
    });
    input.assertCurrent();
    return ready;
  });
  const request = await callAdd("apply");
  expect(readPolicySync).not.toHaveBeenCalled();
  expect(request).toEqual([[true, ready]]);
});

it("guards live authority while leaving post-admission Labs policy to the Add service", async () => {
  let authorized = true;
  const revoked = await applyThrough(
    (input) => {
      authorized = false;
      input.assertCurrent();
    },
    { hasCurrentClientAuthority: () => authorized },
  );
  expect(revoked[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });

  let labsEnabled = true;
  applyAdd.mockImplementation(async (input) => {
    labsEnabled = false;
    input.assertCurrent();
    return complete;
  });
  const switchedOff = await callAdd("apply", () => (labsEnabled ? enabled : {}));
  expect(switchedOff).toEqual([[true, complete]]);
});

it("blocks Add when persisted Labs is off despite a stale Gateway cache", async () => {
  readPolicy.mockResolvedValue({});

  const request = await callAdd("apply");

  expect(request[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
  expect(applyAdd).not.toHaveBeenCalled();
});

it.each([
  [new TemplateGatewayPlanChangedError(), {}],
  [
    new TemplateGatewayConsentError("Review plugin"),
    { details: { code: "TEMPLATE_REVIEW_REQUIRED", kind: "plugin" } },
  ],
  [
    new TemplateSkillConsentError("Review skill"),
    {
      message: "Review skill",
      details: { code: "TEMPLATE_REVIEW_REQUIRED", kind: "skill" },
    },
  ],
  [new TemplateGatewayPlanBlockedError("Unavailable skill"), { message: "Unavailable skill" }],
  [
    new ClawHubSourceError(
      "clawhub_risk_acknowledgement_required",
      "Acknowledge risk",
      "Analysis pending",
    ),
    {
      message: "Acknowledge risk",
      details: {
        code: "CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED",
        warning: "Analysis pending",
      },
    },
  ],
  [new ClawHubSourceError("clawhub_artifact_unavailable", "No artifact"), { code: "UNAVAILABLE" }],
] as const)("maps Add service rejection %s", async (error, expected) => {
  applyAdd.mockRejectedValueOnce(error);
  const replies = await callAdd("apply");
  expect(replies[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST", ...expected });
});

it("validates Template schedule delivery before calling the scheduler", async () => {
  const cron = makeCron({});
  const config = { ...enabled, cron: { failureAlert: { channel: "unconfigured" } } };
  validateDelivery.mockRejectedValueOnce(new Error("Unconfigured failure route"));
  const request = await applyThrough((input) => input.cronGateway!.add(schedule), { cron }, config);

  expect(cron.add).not.toHaveBeenCalled();
  expect(request[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
});

it("exposes guarded scheduler reads and removal for Add rollback", async () => {
  const job: CronJob = {
    ...schedule,
    id: "job-1",
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
  };
  const cron = makeCron({
    readJob: vi.fn().mockResolvedValue(job),
    remove: vi.fn().mockResolvedValue({ ok: true, removed: true }),
  });
  const commitGuard = vi.fn();
  const request = await applyThrough(
    async (input) => {
      expect(await input.cronGateway!.get!("job-1")).toEqual({
        ...job,
        configRevision: resolveCronJobConfigRevision(job),
      });
      await input.cronGateway!.remove!("job-1", {
        expectedConfigRevision: "revision-1",
        commitGuard,
      });
    },
    { cron },
  );

  expect(commitGuard).toHaveBeenCalled();
  expect(cron.remove).toHaveBeenCalledWith("job-1", {
    commitGuard: expect.any(Function),
    expectedConfigRevision: "revision-1",
  });
  expect(request[0]?.[0]).toBe(true);
});

it("rolls back only the unchanged new agent and its scheduled work", async () => {
  const expectedAgentConfig = { id: agentId, workspace: "/tmp/workflow-operator" };
  const removeAgentJobsTransactional = vi.fn(async (_agentId, commit) => await commit());
  const cron = makeCron({ removeAgentJobsTransactional });
  const request = await applyThrough(
    (input) => input.rollbackNewAgent!(agentId, expectedAgentConfig, []),
    { cron },
  );

  expect(removeAgentJobsTransactional).toHaveBeenCalledWith(agentId, expect.any(Function));
  expect(deleteAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId }));
  const { validate } = expectDefined(deleteAgent.mock.calls[0], "agent rollback attempt")[0];
  expect(() => validate(expectedAgentConfig)).not.toThrow();
  expect(() => validate({ ...expectedAgentConfig, name: "Edited" })).toThrow(
    "rollback left it intact",
  );
  expect(request[0]?.[0]).toBe(true);
});

it.each(["scratch", "enable"] as const)(
  "rechecks live Add authority at the %s commit",
  async (operation) => {
    let authorized = true;
    const persisted = vi.fn();
    const cron = makeCron({
      writeScratch: vi.fn(async (_id, options) => {
        authorized = false;
        options.commitGuard();
        persisted();
        return { ok: true };
      }),
      updateWithPrecondition: vi.fn(async (_id, _patch, _precondition, options) => {
        authorized = false;
        options.commitGuard();
        persisted();
      }),
    });
    const request = await applyThrough(
      async (input) => {
        if (operation === "scratch") {
          await input.cronGateway!.writeScratch!("job-1", "Checklist", () => {});
        } else {
          await input.cronGateway!.enable!("job-1", "reviewed-revision", () => {});
        }
      },
      {
        cron,
        hasCurrentClientAuthority: () => authorized,
      },
    );

    expect(persisted).not.toHaveBeenCalled();
    expect(request[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
  },
);

it("keeps the new agent when another automation appears before rollback", async () => {
  const cron = makeCron({
    list: vi.fn().mockResolvedValue([{ id: "user-job", agentId }]),
    removeAgentJobsTransactional: vi.fn(),
  });
  const request = await applyThrough(
    (input) =>
      input.rollbackNewAgent!(agentId, { id: agentId, workspace: "/tmp/workflow-operator" }, []),
    {
      cron,
    },
  );

  expect(request[0]?.[0]).toBe(false);
  expect(cron.removeAgentJobsTransactional).not.toHaveBeenCalled();
  expect(deleteAgent).not.toHaveBeenCalled();
});

it("rejects a declaration created after the Template list check without mutating it", async () => {
  const cron = makeCron({
    add: vi.fn(async (_input, options) => {
      options.matchesExisting({
        declarationKey: schedule.declarationKey,
        agentId,
        owner: { agentId },
      });
      return { id: "intervening-job" };
    }),
  });
  validateDelivery.mockResolvedValue(undefined);
  const request = await applyThrough(
    async (input) => {
      expect(await input.cronGateway!.list!(agentId)).toEqual({ jobs: [] });
      await input.cronGateway!.add(schedule);
    },
    { cron },
  );

  expect(request[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
});

it("rechecks reviewed access at the scheduler's actual Add commit", async () => {
  const commitGuard = vi.fn();
  const persisted = vi.fn();
  const cron = makeCron({
    add: vi.fn(async (_input, options) => {
      commitGuard.mockImplementation(() => {
        throw new Error("Reviewed access revoked");
      });
      options.commitGuard();
      persisted();
      return { id: "new-job" };
    }),
  });
  validateDelivery.mockResolvedValue(undefined);
  const request = await applyThrough((input) => input.cronGateway!.add(schedule, { commitGuard }), {
    cron,
  });

  expect(persisted).not.toHaveBeenCalled();
  expect(request[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
});

it("rechecks reviewed access at the plugin reload's persistent apply", async () => {
  const commitGuard = vi.fn();
  const applied = vi.fn();
  reloadPlugin.mockImplementation(async ({ beforePersistentApply }) => {
    commitGuard.mockImplementation(() => {
      throw new Error("Reviewed access revoked");
    });
    beforePersistentApply();
    applied();
    return { application: { status: "applied" } };
  });
  const request = await applyThrough(
    (input) =>
      input.reloadPlugins!([{ pluginId: "workflow-plugin", installHash: "fixture-install" }], {
        commitGuard,
      }),
    { applyPluginLifecycleChange: vi.fn() },
  );

  expect(applied).not.toHaveBeenCalled();
  expect(request[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
});
