import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getRuntimeConfigWriteApplication } from "../../config/runtime-write-application.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import type { CronJob } from "../../cron/types.js";
import { ClawHubSourceError } from "../../templates/clawhub-source.js";
import {
  TemplateGatewayPlanBlockedError,
  TemplateGatewayPlanChangedError,
} from "../../templates/gateway-add-apply.js";
import type { TemplateAddSource } from "../../templates/gateway-add-source.js";
import { TemplateGatewayConsentError } from "../../templates/gateway-plugin-consent.js";
import { TemplateSkillConsentError } from "../../templates/gateway-skill-consent.js";
import { TemplateProjectError } from "../../templates/project.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import { templatesAddHandlers } from "./templates-add.js";
import type { RespondFn } from "./types.js";

const diagnosticLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) =>
      name === "gateway/templates-add"
        ? { ...actual.createSubsystemLogger(name), ...diagnosticLog }
        : actual.createSubsystemLogger(name),
  };
});

const planAdd = vi.hoisted(() => vi.fn());
const applyAdd = vi.hoisted(() => vi.fn());
const listMcp = vi.hoisted(() => vi.fn());
const readPolicySync = vi.hoisted(() => vi.fn());
const readPolicy = vi.hoisted(() => vi.fn());
const validateDelivery = vi.hoisted(() => vi.fn());
const reloadPlugin = vi.hoisted(() => vi.fn());
const deleteAgent = vi.hoisted(() => vi.fn());
const captureCreator = vi.hoisted(() => vi.fn());
// mock-isolation: Account persistence and revocation use the native inference-binding
// suite; this adapter suite supplies capture facts while testing its other fences.
vi.mock("./cron-input-validation.js", async (original) => ({
  ...(await original<typeof import("./cron-input-validation.js")>()),
  captureCronCreatorSession: captureCreator,
}));
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
  captureCreator.mockResolvedValue({});
  listMcp.mockResolvedValue({ ok: true, mcpServers: {} });
  readPolicy.mockResolvedValue(enabled);
});

afterEach(() => vi.clearAllMocks());

const params = { source, planIntegrity: "sha256:reviewed", acknowledgeCapabilities: [] };
const plan = { operation: "add", planIntegrity: "sha256:reviewed", target: { agentId } };

function makeCron<T extends object>(overrides: T) {
  return {
    add: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    getDefaultAgentId: () => "main",
    ...overrides,
  };
}

async function callAdd(
  operation: "plan" | "apply",
  getRuntimeConfig: () => unknown = () => enabled,
  options: {
    hasCurrentClientAuthority?: () => boolean;
    source?: TemplateAddSource;
    cron?: unknown;
    applyPluginLifecycleChange?: unknown;
    applyParams?: Record<string, unknown>;
  } = {},
) {
  const {
    hasCurrentClientAuthority,
    source: sourceOverride = source,
    applyParams = params,
    ...runtime
  } = options;
  const method = `templates.add.${operation}`;
  const respond = vi.fn<RespondFn>();
  const handler = expectDefined(templatesAddHandlers[method], method);
  await handler({
    req: { type: "req", id: "add", method },
    params:
      operation === "plan"
        ? { source: sourceOverride }
        : { ...applyParams, ...(options.source ? { source: sourceOverride } : {}) },
    respond,
    context: { getRuntimeConfig, ...runtime } as never,
    client:
      operation === "apply" || "kind" in sourceOverride
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
  "templates.add.%s requires its scope and Templates availability",
  async (operation) => {
    const method = `templates.add.${operation}`;
    expect(coreGatewayHandlers[method]).toBeDefined();
    expect(
      authorizeOperatorScopesForMethod(method, operation === "plan" ? [] : ["operator.read"]),
    ).toEqual({
      allowed: false,
      missingScope: operation === "plan" ? "operator.read" : "operator.admin",
    });
    const request = await callAdd(operation, () => ({
      gateway: { controlUi: { experimental: { templates: false } } },
    }));
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
    onStage: expect.any(Function),
    config: onDisk,
    resolvePreferredModel: expect.any(Function),
    sourceMcpServers: expect.any(Function),
  });
  expect(listMcp).not.toHaveBeenCalled();
  expect(request).toEqual([[true, plan]]);
});

it("drops a preview if Templates availability is switched off mid-request", async () => {
  let calls = 0;
  planAdd.mockResolvedValue(plan);
  const request = await callAdd("plan", () =>
    calls++ === 0 ? enabled : { gateway: { controlUi: { experimental: { templates: false } } } },
  );
  expect(request[0]?.[2]).toMatchObject({
    code: "FORBIDDEN",
    details: { mutationAccepted: false },
  });
});

it.each([
  new ClawHubSourceError("clawhub_manifest_invalid", "Manifest is invalid"),
  new Error("MCP listing failed"),
])("reports a failed preview as having no effect: %s", async (error) => {
  planAdd.mockRejectedValueOnce(error);
  const replies = await callAdd("plan");
  expect(replies[0]?.[2]).toMatchObject({
    code: "UNAVAILABLE",
    details: { mutationAccepted: false },
  });
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
      resolvePreferredModel: expect.any(Function),
      sourceMcpServers: expect.any(Function),
    });
    expect(listMcp).not.toHaveBeenCalled();
    input.assertCurrent();
    return ready;
  });
  const request = await callAdd("apply");
  expect(readPolicySync).not.toHaveBeenCalled();
  expect(request).toEqual([[true, ready]]);
});

it("routes to chat-based creation only on its explicit mode", async () => {
  applyAdd.mockResolvedValue(complete);
  const chat = { mode: "chat", source, agentId };
  await callAdd("apply");
  await callAdd("apply", () => enabled, { applyParams: chat });
  // The reviewed request keeps its installer hand-off: opening at agent-ready, install events.
  const [reviewed, created] = applyAdd.mock.calls.map(([input]) => input);
  expect(reviewed).toMatchObject({
    planIntegrity: params.planIntegrity,
    acknowledgeCapabilities: [],
    onAgentReady: expect.any(Function),
    onSetupEvent: expect.any(Function),
  });
  expect(Object.keys(reviewed)).not.toContain("mode");
  expect(Object.keys(reviewed)).not.toContain("onAgentCreated");
  // Chat-based creation opens once, after creation, and publishes no installer events.
  expect(created).toMatchObject({ ...chat, onAgentCreated: expect.any(Function) });
  for (const reviewedOnly of ["planIntegrity", "onAgentReady", "onSetupEvent"]) {
    expect(Object.keys(created)).not.toContain(reviewedOnly);
  }
  const mixed = await callAdd("apply", () => enabled, {
    applyParams: { ...chat, planIntegrity: params.planIntegrity },
  });
  expect(mixed[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
  expect(applyAdd).toHaveBeenCalledTimes(2);
});

it.each(["plan", "apply"] as const)(
  "templates.add.%s reads MCP servers as the config file declares them",
  async (operation) => {
    const declared = { command: "node", env: { TOKEN: "${FIXTURE_MCP_TOKEN}" } };
    listMcp.mockResolvedValue({
      ok: true,
      mcpServers: { docs: { command: "node", env: { TOKEN: "synthetic-token" } } },
      authoredConfig: { mcp: { servers: { docs: declared } } },
    });
    let servers: unknown;
    planAdd.mockImplementation(async (input) => {
      servers = await input.sourceMcpServers();
      return plan;
    });
    applyAdd.mockImplementation(async (input) => {
      servers = await (await input.getPlanningContext()).sourceMcpServers();
      return ready;
    });
    await callAdd(operation);
    expect(servers).toEqual({ docs: declared });
  },
);

it.each(["applied", "applied-restart-required", "restart-pending"] as const)(
  "reports the reload owner's %s receipt without admitting an unpublished agent",
  async (outcome) => {
    const response = await applyThrough(async (input) => {
      const application = expectDefined(
        getRuntimeConfigWriteApplication(input.configWriteOptions!),
        "Template config application receipt",
      );
      const claim = expectDefined(application.claim(), "Template config application claim");
      claim.settle(outcome);
      if (outcome === "restart-pending") {
        await expect(input.waitForAgentRuntime!()).rejects.toThrow(
          "not confirmed (restart-pending)",
        );
      } else {
        await expect(input.waitForAgentRuntime!()).resolves.toBe(outcome);
      }
    });
    expect(response).toEqual([[true, complete]]);
  },
);

it("uses separate exact-write runtime receipts for admission and verified Template initialization", async () => {
  const response = await applyThrough(async (input) => {
    const admission = expectDefined(
      getRuntimeConfigWriteApplication(input.admissionConfigWriteOptions!),
      "ordinary admission receipt",
    );
    const initialization = expectDefined(
      getRuntimeConfigWriteApplication(input.configWriteOptions!),
      "Template initialization receipt",
    );
    expect(admission).not.toBe(initialization);
    expectDefined(admission.claim(), "admission claim").settle("applied");
    await expect(input.waitForAdmissionRuntime!()).resolves.toBe("applied");
    expect(initialization.claimed).toBe(false);
    expectDefined(initialization.claim(), "initialization claim").settle(
      "applied-restart-required",
    );
    await expect(input.waitForAgentRuntime!()).resolves.toBe("applied-restart-required");
  });
  expect(response).toEqual([[true, complete]]);
});

it.each(["matching", "stale"] as const)(
  "validates retained agent against the active runtime: %s",
  async (state) => {
    const retained = { agentId, config: { name: "Reviewed", workspace: "/tmp/retained-template" } };
    const runtime = {
      ...enabled,
      agents: {
        entries: {
          [agentId]: { ...retained.config, name: state === "matching" ? "Reviewed" : "Changed" },
        },
      },
    };
    const response = await applyThrough(
      async (input) => {
        for (const wait of [input.waitForAdmissionRuntime!, input.waitForAgentRuntime!]) {
          if (state === "matching") {
            await expect(wait(retained)).resolves.toBe("applied");
          } else {
            await expect(wait(retained)).rejects.toThrow("not active in this Gateway");
          }
        }
      },
      {},
      runtime,
    );
    expect(response).toEqual([[true, complete]]);
  },
);

it("guards live authority while leaving post-admission Templates availability policy to the Add service", async () => {
  let authorized = true;
  const revoked = await applyThrough(
    (input) => {
      authorized = false;
      input.assertCurrent();
    },
    { hasCurrentClientAuthority: () => authorized },
  );
  expect(revoked[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });

  let templatesEnabled = true;
  applyAdd.mockImplementation(async (input) => {
    templatesEnabled = false;
    input.assertCurrent();
    return complete;
  });
  const switchedOff = await callAdd("apply", () =>
    templatesEnabled ? enabled : { gateway: { controlUi: { experimental: { templates: false } } } },
  );
  expect(switchedOff).toEqual([[true, complete]]);
});

it("blocks Add when persisted Templates availability is off despite a stale Gateway cache", async () => {
  readPolicy.mockResolvedValue({ gateway: { controlUi: { experimental: { templates: false } } } });

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

it("rejects an existing declaration at the scheduler without relying on a list precheck", async () => {
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
  const request = await applyThrough((input) => input.cronGateway!.add(schedule), { cron });

  expect(cron.list).not.toHaveBeenCalled();

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

it.each(["plan", "apply"] as const)(
  "logs bounded %s outcomes without source or error data",
  async (operation) => {
    const localSource = { kind: "local" as const, path: "/private/template-secret" };
    const operationMock = operation === "plan" ? planAdd : applyAdd;
    operationMock.mockRejectedValueOnce(new Error("private error with token=secret"));
    const response = await callAdd(operation, () => enabled, { source: localSource });
    expect(response[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });
    expect(diagnosticLog.warn).toHaveBeenCalledExactlyOnceWith("Template add did not complete", {
      operation,
      stage: operation === "plan" ? "source_resolution_and_plan" : "apply",
      outcome: "failed",
      sourceKind: "local",
      correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      durationMs: expect.any(Number),
    });
    expect(diagnosticLog.error).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnosticLog.warn.mock.calls)).not.toContain("private");
    const firstId = diagnosticLog.warn.mock.calls[0]?.[1].correlationId;
    operationMock.mockResolvedValueOnce(operation === "plan" ? plan : ready);
    await callAdd(operation, () => enabled, { source: localSource });
    expect(diagnosticLog.info).toHaveBeenCalledExactlyOnceWith(
      "Template add completed",
      expect.objectContaining({ operation, outcome: "success", sourceKind: "local" }),
    );
    expect(diagnosticLog.info.mock.calls[0]?.[1].correlationId).not.toBe(firstId);
  },
);

it.each(["plan", "apply"] as const)(
  "records the failing upload stage for %s",
  async (operation) => {
    const operationMock = operation === "plan" ? planAdd : applyAdd;
    operationMock.mockImplementationOnce(async (input) => {
      input.onStage?.("upload_decode_and_staging");
      input.onStage?.("upload_extraction");
      throw new Error("private upload error");
    });
    await callAdd(operation, () => enabled, { source: { kind: "upload", archiveBase64: "YWJj" } });
    expect(diagnosticLog.warn).toHaveBeenCalledExactlyOnceWith(
      "Template add did not complete",
      expect.objectContaining({
        operation,
        stage: "upload_extraction",
        outcome: "failed",
        sourceKind: "upload",
      }),
    );
    expect(JSON.stringify(diagnosticLog.warn.mock.calls)).not.toContain("private");
  },
);

it("records local source authority rejection without resolving the source", async () => {
  await callAdd("plan", () => enabled, {
    source: { kind: "local", path: "/private/template-secret" },
    hasCurrentClientAuthority: () => false,
  });
  expect(planAdd).not.toHaveBeenCalled();
  expect(diagnosticLog.warn).toHaveBeenCalledExactlyOnceWith(
    "Template add did not complete",
    expect.objectContaining({ stage: "policy", outcome: "forbidden", sourceKind: "local" }),
  );
});

it("records a partial Add as a non-success outcome", async () => {
  applyAdd.mockResolvedValueOnce({ ...complete, status: "partial" });
  await callAdd("apply");
  expect(diagnosticLog.info).not.toHaveBeenCalled();
  expect(diagnosticLog.warn).toHaveBeenCalledExactlyOnceWith(
    "Template add did not complete",
    expect.objectContaining({ operation: "apply", stage: "apply", outcome: "partial" }),
  );
});

it.each(["plan", "apply"] as const)(
  "returns actionable invalid-project diagnostics for %s",
  async (operation) => {
    const service = operation === "plan" ? planAdd : applyAdd;
    service.mockRejectedValueOnce(
      new TemplateProjectError("project_invalid", "missing openclaw.template"),
    );
    const replies = await callAdd(operation, () => enabled, {
      source: { kind: "local", path: "/tmp/invalid-template" },
    });
    expect(replies[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringMatching(/missing openclaw.template.*templates validate/s),
    });
  },
);
