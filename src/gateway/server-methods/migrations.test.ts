// Gateway migration tests cover agent scoping, fresh plans, and exact item selection.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";

const mocks = vi.hoisted(() => ({
  providers: [] as MigrationProviderPlugin[],
  runMigrationApply: vi.fn(),
}));

vi.mock("../../plugins/migration-provider-runtime.js", () => ({
  ensureStandaloneMigrationProviderRegistryLoaded: vi.fn(),
  resolvePluginMigrationProviders: vi.fn(() => mocks.providers),
}));

vi.mock("../../commands/migrate/apply.js", () => ({
  runMigrationApply: mocks.runMigrationApply,
}));

import { migrationsHandlers } from "./migrations.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createConfig() {
  return {
    agents: {
      defaults: { workspace: "/tmp/workspace-main" },
      list: [
        { id: "main", default: true },
        { id: "research", workspace: "/tmp/workspace-research" },
      ],
    },
  } as never;
}

let config = createConfig();

function memoryPlan(): MigrationPlan {
  return {
    providerId: "codex",
    source: "/tmp/codex",
    target: "/tmp/workspace-research",
    summary: {
      total: 2,
      planned: 2,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items: [
      {
        id: "memory:one",
        kind: "memory",
        action: "copy",
        status: "planned",
        source: "/tmp/codex/MEMORY.md",
        target: "/tmp/workspace-research/memory/imports/codex/MEMORY.md",
      },
      {
        id: "workspace:ignored",
        kind: "workspace",
        action: "copy",
        status: "planned",
        source: "/tmp/codex/AGENTS.md",
        target: "/tmp/workspace-research/AGENTS.md",
      },
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
      source: "/tmp/codex",
      confidence: "high" as const,
    })),
    plan: vi.fn(async (ctx) => {
      expect(ctx.targetAgentId).toBe("research");
      expect(ctx.itemKinds).toEqual(["memory"]);
      return plan;
    }),
    apply: vi.fn(),
  };
}

function invoke(method: keyof typeof migrationsHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    run: async () =>
      await expectDefined(
        migrationsHandlers[method],
        `${method} handler test invariant`,
      )({
        params,
        respond: respond as never,
        context: { getRuntimeConfig: () => config } as never,
        client: null,
        req: { type: "req", id: "req-1", method },
        isWebchatConnect: () => false,
      }),
  };
}

function firstCall(respond: ReturnType<typeof vi.fn>): RespondCall {
  const call = respond.mock.calls[0] as RespondCall | undefined;
  if (!call) {
    throw new Error("expected gateway response");
  }
  return call;
}

async function loadPlanFingerprint(): Promise<string> {
  const request = invoke("migrations.memory.plan", { agentId: "research" });
  await request.run();
  const [ok, rawResult] = firstCall(request.respond);
  expect(ok).toBe(true);
  const result = rawResult as {
    providers: Array<{ planFingerprint?: string }>;
  };
  const fingerprint = result.providers[0]?.planFingerprint;
  if (!fingerprint) {
    throw new Error("expected memory plan fingerprint");
  }
  return fingerprint;
}

describe("memory migration gateway handlers", () => {
  beforeEach(() => {
    config = createConfig();
    mocks.providers = [provider()];
    mocks.runMigrationApply.mockReset();
  });

  it("returns memory-only plans for the selected agent", async () => {
    const request = invoke("migrations.memory.plan", { agentId: "research" });

    await request.run();

    const [ok, rawResult] = firstCall(request.respond);
    expect(ok).toBe(true);
    const result = rawResult as {
      agentId: string;
      workspace: string;
      providers: Array<{ items: Array<{ id: string }>; summary: { total: number } }>;
    };
    expect(result.agentId).toBe("research");
    expect(result.workspace).toBe("/tmp/workspace-research");
    expect(result.providers[0]?.items.map((item) => item.id)).toEqual(["memory:one"]);
    expect(result.providers[0]?.summary.total).toBe(1);
    expect(
      (result.providers[0] as { planFingerprint?: string } | undefined)?.planFingerprint,
    ).toMatch(/^[a-f0-9]{64}$/u);
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
    const request = invoke("migrations.memory.plan", { agentId: "research" });

    await request.run();

    const [, rawResult] = firstCall(request.respond);
    const result = rawResult as {
      providers: Array<{ error?: string; items: unknown[] }>;
    };
    expect(result.providers[0]?.error).toContain("maximum is 2000");
    expect(result.providers[0]?.items).toEqual([]);
  });

  it("rejects an unknown destination agent", async () => {
    const request = invoke("migrations.memory.plan", { agentId: "missing" });

    await request.run();

    const [ok, , error] = firstCall(request.respond);
    expect(ok).toBe(false);
    expect(error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(error?.message).toContain("unknown agent id");
  });

  it("rejects stale item ids from a freshly rebuilt apply plan", async () => {
    const planFingerprint = await loadPlanFingerprint();
    const request = invoke("migrations.memory.apply", {
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:stale"],
    });

    await request.run();

    const [ok, , error] = firstCall(request.respond);
    expect(ok).toBe(false);
    expect(error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(error?.message).toContain("refresh the plan");
    expect(mocks.runMigrationApply).not.toHaveBeenCalled();
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
    const request = invoke("migrations.memory.apply", {
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    });

    await request.run();

    const [ok, rawResult] = firstCall(request.respond);
    expect(ok).toBe(true);
    expect(rawResult).toMatchObject({
      reportDir: "/tmp/migration-report",
      summary: { errors: 1 },
      items: [{ details: { recoveryPath: "/tmp/staged-memory" } }],
    });
  });

  it("rejects apply when the selected agent workspace changed after preview", async () => {
    const planFingerprint = await loadPlanFingerprint();
    const mutableConfig = config as {
      agents: { list: Array<{ id: string; workspace?: string }> };
    };
    const research = mutableConfig.agents.list.find((agent) => agent.id === "research");
    if (!research) {
      throw new Error("expected research agent");
    }
    research.workspace = "/tmp/workspace-research-moved";

    const request = invoke("migrations.memory.apply", {
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    });
    await request.run();

    const [ok, , error] = firstCall(request.respond);
    expect(ok).toBe(false);
    expect(error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(error?.message).toContain("plan changed");
    expect(mocks.runMigrationApply).not.toHaveBeenCalled();
  });
});
