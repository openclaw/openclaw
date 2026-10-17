import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({
  providers: [] as MigrationProviderPlugin[],
  runMigrationApply: vi.fn(),
}));

vi.mock("../../plugins/migration-provider-runtime.js", () => ({
  withPluginMigrationProviders: async (
    _params: unknown,
    run: (providers: MigrationProviderPlugin[]) => Promise<unknown>,
  ) => await run(mocks.providers),
}));

vi.mock("../../commands/migrate/apply.js", () => ({
  runMigrationApply: async (
    params: Parameters<typeof import("../../commands/migrate/apply.js").runMigrationApply>[0],
  ) => {
    const result = await mocks.runMigrationApply(params);
    params.onApplyCompleted?.();
    return result;
  },
}));

import { migrationsHandlers } from "./migrations.js";

type RespondCall = [
  boolean,
  unknown?,
  { code: number; message: string }?,
  Record<string, unknown>?,
];

function createConfig() {
  return {
    agents: {
      defaults: { workspace: "/tmp/workspace-main" },
      entries: {
        main: {},
        research: { workspace: "/tmp/workspace-research" },
      },
    },
  };
}

let config = createConfig();
let sourceRoot = "";
let dedupe: Map<string, { ts: number; ok: boolean; payload?: unknown }>;

function memoryPlan(memoryOnly = false): MigrationPlan {
  const item = (id: string, kind: "memory" | "workspace", file: string) => ({
    id,
    kind,
    action: "copy" as const,
    status: "planned" as const,
    source: path.join(sourceRoot, file),
    target: `/tmp/workspace-research/${kind === "memory" ? "memory/imports/codex/" : ""}${file}`,
  });
  return {
    providerId: "codex",
    source: sourceRoot,
    target: "/tmp/workspace-research",
    summary: {
      total: memoryOnly ? 1 : 2,
      planned: 2,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items: [
      item("memory:one", "memory", "MEMORY.md"),
      ...(memoryOnly ? [] : [item("workspace:ignored", "workspace", "AGENTS.md")]),
    ],
  };
}

function provider(plan = memoryPlan()): MigrationProviderPlugin {
  return {
    id: "codex",
    label: "Codex",
    supportedItemKinds: ["memory"],
    detect: vi.fn(async () => ({
      found: true,
      source: sourceRoot,
      confidence: "high" as const,
    })),
    plan: vi.fn(async (ctx) => {
      expect(ctx).toMatchObject({ targetAgentId: "research", itemKinds: ["memory"] });
      return plan;
    }),
    apply: vi.fn(),
  };
}

function invoke(method: keyof typeof migrationsHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  const requestParams =
    method === "migrations.memory.apply" && !("idempotencyKey" in params)
      ? { idempotencyKey: "memory-import-test", ...params }
      : params;
  return {
    respond,
    run: async () =>
      await expectDefined(
        migrationsHandlers[method],
        `${method} handler test invariant`,
      )({
        params: requestParams,
        respond: respond as never,
        context: { getRuntimeConfig: () => config, dedupe } as never,
        client: null,
        req: { type: "req", id: "req-1", method },
        isWebchatConnect: () => false,
      }),
  };
}

function firstCall(respond: ReturnType<typeof vi.fn>): RespondCall {
  return expectDefined(respond.mock.calls[0], "expected gateway response") as RespondCall;
}

async function loadPlanFingerprint(overwrite = false): Promise<string> {
  const [ok, rawResult] = await response("migrations.memory.plan", {
    agentId: "research",
    ...(overwrite ? { overwrite: true } : {}),
  });
  expect(ok).toBe(true);
  const fingerprint = (rawResult as { providers: Array<{ planFingerprint?: string }> }).providers[0]
    ?.planFingerprint;
  if (!fingerprint) {
    throw new Error("expected memory plan fingerprint");
  }
  return fingerprint;
}

function applyParams(planFingerprint: string, overrides: Record<string, unknown> = {}) {
  return {
    agentId: "research",
    providerId: "codex",
    planFingerprint,
    itemIds: ["memory:one"],
    ...overrides,
  };
}

async function response(
  method: keyof typeof migrationsHandlers,
  params: Record<string, unknown> = { agentId: "research" },
) {
  const request = invoke(method, params);
  await request.run();
  return firstCall(request.respond);
}

async function expectRejectedApply(planFingerprint: string, message: string, overrides = {}) {
  const [ok, , error] = await response(
    "migrations.memory.apply",
    applyParams(planFingerprint, overrides),
  );
  expect(ok).toBe(false);
  expect(error?.message).toContain(message);
  expect(mocks.runMigrationApply).not.toHaveBeenCalled();
  return error;
}

describe("memory migration gateway handlers", () => {
  beforeEach(async () => {
    sourceRoot = tempDirs.make("openclaw-memory-gateway-");
    await fs.writeFile(path.join(sourceRoot, "MEMORY.md"), "reviewed memory", "utf8");
    config = createConfig();
    mocks.providers = [provider()];
    mocks.runMigrationApply.mockReset();
    dedupe = new Map();
  });

  it("returns memory-only plans for the selected agent", async () => {
    const [ok, rawResult] = await response("migrations.memory.plan");
    expect(ok).toBe(true);
    expect(rawResult).toMatchObject({
      agentId: "research",
      workspace: "/tmp/workspace-research",
      providers: [
        {
          items: [{ id: "memory:one" }],
          summary: { total: 1 },
          planFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      ],
    });
  });

  it("reports oversized provider plans instead of returning an unusable selection", async () => {
    const oversized = memoryPlan();
    oversized.items = Array.from({ length: 2001 }, (_, index) => ({
      ...oversized.items[0]!,
      id: `memory:${index}`,
    }));
    oversized.summary.total = oversized.items.length;
    oversized.summary.planned = oversized.items.length;
    mocks.providers = [provider(oversized)];
    const [, rawResult] = await response("migrations.memory.plan");
    expect(rawResult).toMatchObject({
      providers: [{ error: expect.stringContaining("maximum is 2000"), items: [] }],
    });
  });

  it.each([
    ["missing", "unknown agent id"],
    ["research!!!", "invalid agent id"],
  ])("rejects destination agent %s before normalization", async (agentId, message) => {
    const [ok, , error] = await response("migrations.memory.plan", { agentId });
    expect(ok).toBe(false);
    expect(error).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: expect.stringContaining(message),
    });
  });

  it.each([false, true])("binds source bytes after preview (overwrite=%s)", async (overwrite) => {
    const plan = memoryPlan();
    if (overwrite) {
      plan.items[0]!.status = "conflict";
      plan.items[0]!.reason = "target exists";
      plan.summary = { ...plan.summary, planned: 1, conflicts: 1 };
    }
    mocks.providers = [provider(plan)];
    const planFingerprint = await loadPlanFingerprint(overwrite);
    await fs.writeFile(path.join(sourceRoot, "MEMORY.md"), "changed memory", "utf8");
    await expectRejectedApply(planFingerprint, "plan changed", { overwrite });
  });

  it("reports unsupported actionable memory operations during planning", async () => {
    const plan = memoryPlan();
    plan.items[0]!.action = "append";
    mocks.providers = [provider(plan)];
    const [ok, rawResult] = await response("migrations.memory.plan");
    expect(ok).toBe(true);
    expect(rawResult).toMatchObject({
      providers: [{ found: false, error: expect.stringContaining("only supports copy actions") }],
    });
  });

  it.each([
    ["metadata", (plan: MigrationPlan) => (plan.metadata = { revision: "new" })],
    ["warnings", (plan: MigrationPlan) => (plan.warnings = ["updated warning"])],
    ["item message", (plan: MigrationPlan) => (plan.items[0]!.message = "updated message")],
    ["operation", (plan: MigrationPlan) => (plan.items[0]!.action = "append")],
  ])("rejects apply when plan %s changes after preview", async (field, mutatePlan) => {
    const plan = memoryPlan();
    mocks.providers = [provider(plan)];
    const planFingerprint = await loadPlanFingerprint();
    mutatePlan(plan);
    await expectRejectedApply(
      planFingerprint,
      field === "operation" ? "only supports copy actions" : "plan changed",
    );
  });

  it("rejects stale item ids from a freshly rebuilt apply plan", async () => {
    const planFingerprint = await loadPlanFingerprint();
    const error = await expectRejectedApply(planFingerprint, "refresh the plan", {
      itemIds: ["memory:stale"],
    });
    expect(error?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });

  it("applies only the exact selected ids from the fresh plan", async () => {
    const applied = memoryPlan();
    applied.items = [applied.items[0]!];
    applied.summary.total = 1;
    mocks.runMigrationApply.mockResolvedValue(applied);
    const planFingerprint = await loadPlanFingerprint();
    const request = invoke("migrations.memory.apply", {
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    });

    await request.run();

    expect(firstCall(request.respond)[0]).toBe(true);
    expect(mocks.runMigrationApply).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "codex",
        opts: expect.objectContaining({
          targetAgentId: "research",
          itemKinds: ["memory"],
          itemIds: ["memory:one"],
          allowPartialResult: true,
          preflightPlan: expect.objectContaining({ providerId: "codex" }),
        }),
      }),
    );
  });

  it("replays a completed import when its idempotency key is retried", async () => {
    mocks.runMigrationApply.mockResolvedValue(memoryPlan(true));
    const planFingerprint = await loadPlanFingerprint();
    const params = applyParams(planFingerprint, { idempotencyKey: "memory-import-retry" });
    const first = invoke("migrations.memory.apply", params);
    await first.run();
    await fs.writeFile(path.join(sourceRoot, "MEMORY.md"), "changed after import", "utf8");
    const retry = invoke("migrations.memory.apply", params);

    await retry.run();

    expect(firstCall(first.respond)[0]).toBe(true);
    expect(firstCall(retry.respond)[0]).toBe(true);
    expect(firstCall(retry.respond)[3]).toEqual({ cached: true });
    expect(mocks.runMigrationApply).toHaveBeenCalledOnce();
  });

  it("joins identical in-flight retries and rejects mismatched key reuse", async () => {
    const applied = memoryPlan(true);
    let finishApply!: (result: MigrationPlan) => void;
    mocks.runMigrationApply.mockImplementation(
      async () =>
        await new Promise<MigrationPlan>((resolve) => {
          finishApply = resolve;
        }),
    );
    const planFingerprint = await loadPlanFingerprint();
    const params = applyParams(planFingerprint, { idempotencyKey: "memory-import-in-flight" });
    const first = invoke("migrations.memory.apply", params);
    const firstRun = first.run();
    await vi.waitFor(() => expect(mocks.runMigrationApply).toHaveBeenCalledOnce());

    const mismatched = invoke("migrations.memory.apply", {
      ...params,
      itemIds: ["memory:other"],
    });
    await mismatched.run();
    expect(firstCall(mismatched.respond)[2]?.message).toContain("idempotency key was reused");

    const retry = invoke("migrations.memory.apply", params);
    const retryRun = retry.run();
    await Promise.resolve();
    expect(retry.respond).not.toHaveBeenCalled();
    finishApply(applied);
    await Promise.all([firstRun, retryRun]);

    expect(firstCall(first.respond)[0]).toBe(true);
    expect(firstCall(retry.respond)[0]).toBe(true);
    expect(firstCall(retry.respond)[3]).toEqual({ cached: true });
    expect(mocks.runMigrationApply).toHaveBeenCalledOnce();
  });

  it("rejects an idempotency key reused for a different import", async () => {
    const applied = memoryPlan();
    applied.items = [applied.items[0]!];
    applied.summary.total = 1;
    mocks.runMigrationApply.mockResolvedValue(applied);
    const planFingerprint = await loadPlanFingerprint();
    const first = invoke("migrations.memory.apply", {
      idempotencyKey: "memory-import-reused",
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    });
    await first.run();
    const reused = invoke("migrations.memory.apply", {
      idempotencyKey: "memory-import-reused",
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:other"],
    });

    await reused.run();

    const [ok, , error] = firstCall(reused.respond);
    expect(ok).toBe(false);
    expect(error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(error?.message).toContain("idempotency key was reused");
    expect(mocks.runMigrationApply).toHaveBeenCalledOnce();
  });

  it("returns partial failures and recovery metadata to the Control UI", async () => {
    const applied = { ...memoryPlan(), reportDir: "/tmp/migration-report" };
    applied.items = [
      {
        ...applied.items[0]!,
        status: "error",
        reason: "copy failed",
        details: { recoveryPath: "/tmp/staged-memory" },
      },
    ];
    applied.summary = { ...applied.summary, total: 1, planned: 0, errors: 1 };
    mocks.runMigrationApply.mockResolvedValue(applied);
    const planFingerprint = await loadPlanFingerprint();
    const [ok, rawResult] = await response("migrations.memory.apply", applyParams(planFingerprint));
    expect(ok).toBe(true);
    expect(rawResult).toMatchObject({
      reportDir: "/tmp/migration-report",
      summary: { errors: 1 },
      items: [{ details: { recoveryPath: "/tmp/staged-memory" } }],
    });
  });

  it("rejects apply when the selected agent workspace changed after preview", async () => {
    const planFingerprint = await loadPlanFingerprint();
    config.agents.entries.research.workspace = "/tmp/workspace-research-moved";
    const error = await expectRejectedApply(planFingerprint, "plan changed");
    expect(error?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });
});
