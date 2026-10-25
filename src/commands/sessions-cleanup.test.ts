import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi, visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import { GatewayCredentialsRequiredError } from "../gateway/call.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { sessionsCleanupLargeLabelsEntrypoint } from "./sessions-cleanup-runtime.test-support.js";
import { cleanupSummary } from "./sessions-cleanup-summary.test-support.js";
import { createCapturingTestRuntime as makeRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveCommandSessionStoreTargets: vi.fn(),
  runSessionsCleanup: vi.fn(),
  runLocalSessionsCleanup: vi.fn(),
  callGateway: vi.fn(),
}));

// mock-isolation: Cleanup routing fixtures supply config without reading operator state.
vi.mock("../config/config.js", async () => {
  const { createTestConfigReadMocks } = await import("./test-runtime-config-helpers.js");
  return {
    ...createTestConfigReadMocks(mocks, "loadConfig"),
  };
});

vi.mock("./sessions-cleanup.runtime.js", () => ({
  runLocalSessionsCleanup: mocks.runLocalSessionsCleanup,
}));

vi.mock("./session-store-targets.js", () => ({
  resolveCommandSessionStoreTargets: mocks.resolveCommandSessionStoreTargets,
}));

vi.mock("../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions.js")>()),
  runSessionsCleanup: mocks.runSessionsCleanup,
}));

vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: mocks.callGateway,
}));

import { sessionsCleanupCommand } from "./sessions-cleanup.js";

function expectLogsToInclude(logs: readonly string[], text: string): void {
  expect(logs.some((line) => line.includes(text))).toBe(true);
}

function gatewayTransportError(kind: "closed" | "timeout", code?: number): GatewayTransportError {
  return new GatewayTransportError({
    kind,
    code,
    message: `gateway ${kind}`,
    connectionDetails: { url: "ws://127.0.0.1:1", urlSource: "test", message: "test gateway" },
  });
}

function gatewayCleanupResult(
  storePath: string,
  overrides: Partial<CleanupPreview["summary"]> = {},
) {
  return {
    ...cleanupPreview({
      storePath,
      mode: "enforce",
      dryRun: false,
      beforeCount: 3,
      afterCount: 1,
      pruned: 2,
      ...overrides,
    }).summary,
    applied: true,
    appliedCount: 1,
  };
}

type CleanupPreview = Awaited<
  ReturnType<typeof import("../config/sessions/cleanup-service.js").runSessionsCleanup>
>["previewResults"][number];

function cleanupPreview(
  summary: Partial<CleanupPreview["summary"]>,
  entries: Partial<Omit<CleanupPreview, "summary">> = {},
) {
  return {
    summary: cleanupSummary({
      storePath: "/resolved/sessions.json",
      beforeCount: 1,
      wouldMutate: true,
      unreferencedArtifacts: undefined,
      ...summary,
    }),
    beforeStore: {},
    missingKeys: new Set<string>(),
    staleKeys: new Set<string>(),
    cappedKeys: new Set<string>(),
    dmScopeRetiredKeys: new Set<string>(),
    modelRunPrunedKeys: new Set<string>(),
    ...entries,
  };
}

function previewEntry(sessionId: string, updatedAt: number, label?: string) {
  return { sessionId, updatedAt, model: "test:opus", ...(label === undefined ? {} : { label }) };
}

function mockPreviews(...previewResults: ReturnType<typeof cleanupPreview>[]) {
  mocks.runSessionsCleanup.mockResolvedValue({
    mode: "warn",
    previewResults,
    appliedSummaries: [],
  });
}

describe("sessionsCleanupCommand", () => {
  let runtime: ReturnType<typeof makeRuntime>["runtime"];
  let logs: string[];
  const cleanup = (options: Parameters<typeof sessionsCleanupCommand>[0]) =>
    sessionsCleanupCommand(options, runtime);

  beforeEach(() => {
    vi.clearAllMocks();
    ({ runtime, logs } = makeRuntime());
    vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
    process.exitCode = undefined;
    mocks.runLocalSessionsCleanup.mockImplementation((params) => mocks.runSessionsCleanup(params));
    mocks.loadConfig.mockReturnValue({ session: { store: "/cfg/sessions.json" } });
    mocks.resolveCommandSessionStoreTargets.mockReturnValue([
      { agentId: "main", storePath: "/resolved/sessions.json" },
    ]);
    mocks.callGateway.mockResolvedValue(null);
    mockPreviews();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps an empty explicit store local instead of delegating default cleanup to the gateway", async () => {
    // Resolve a full result so a regression that delegates fails on the
    // gateway assertion below instead of throwing on the beforeEach null.
    mocks.callGateway.mockResolvedValue(gatewayCleanupResult("/gateway/sessions.json"));
    await cleanup({ store: "", enforce: true });

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.runSessionsCleanup).toHaveBeenCalledOnce();
    expect(mocks.resolveCommandSessionStoreTargets).toHaveBeenCalledWith(
      expect.objectContaining({ opts: expect.objectContaining({ store: "" }) }),
    );
  });

  it("emits a single JSON object for non-dry runs and applies maintenance", async () => {
    mocks.callGateway.mockRejectedValue(gatewayTransportError("closed"));
    const diskBudget = {
      totalBytesBefore: 1200,
      totalBytesAfter: 800,
      removedFiles: 0,
      removedEntries: 0,
      freedBytes: 400,
      maxBytes: 1000,
      highWaterBytes: 800,
      overBudget: true,
    };
    const applied = gatewayCleanupResult("/resolved/sessions.json", {
      pruned: 0,
      capped: 2,
      diskBudget,
    });
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "enforce",
      previewResults: [],
      appliedSummaries: [applied],
    });
    await cleanup({
      json: true,
      enforce: true,
      activeKey: "agent:main:main",
    });

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      ...applied,
      storePath: "/resolved/openclaw-agent.sqlite",
    });
    expect(mocks.runSessionsCleanup).toHaveBeenCalledOnce();
    expect(mocks.runSessionsCleanup.mock.calls[0]?.[0]).toEqual({
      cfg: { session: { store: "/cfg/sessions.json" } },
      opts: expect.objectContaining({ enforce: true, activeKey: "agent:main:main" }),
      targets: [{ agentId: "main", storePath: "/resolved/sessions.json" }],
    });
  });

  it.each([
    { label: "request timeout after dispatch", error: gatewayTransportError("timeout") },
    {
      label: "missing local credentials",
      error: new GatewayCredentialsRequiredError({
        method: "sessions.cleanup",
        configPath: "/tmp/openclaw.json",
      }),
    },
    {
      label: "malformed transport failure",
      error: Object.assign(new Error("malformed transport failure"), {
        name: "GatewayTransportError",
        kind: "closed",
      }),
    },
  ])("surfaces $label without replaying cleanup locally", async ({ error }) => {
    mocks.callGateway.mockRejectedValue(error);
    await expect(cleanup({ enforce: true })).rejects.toBe(error);

    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(mocks.runSessionsCleanup).not.toHaveBeenCalled();
    expect(mocks.runLocalSessionsCleanup).not.toHaveBeenCalled();
  });

  it.each(["remote config", "environment override"])(
    "surfaces a refused loopback tunnel selected by %s without cleaning local sessions",
    async (source) => {
      const url = "ws://127.0.0.1:18789";
      if (source === "remote config") {
        mocks.loadConfig.mockReturnValue({
          gateway: { mode: "remote", remote: { url } },
          session: { store: "/cfg/sessions.json" },
        });
      } else {
        vi.stubEnv("OPENCLAW_GATEWAY_URL", url);
      }
      const error = new GatewayTransportError({
        kind: "closed",
        reason: "connect ECONNREFUSED 127.0.0.1:18789",
        message: "Gateway not reachable (ECONNREFUSED)",
        connectionDetails: { url, urlSource: source, message: "test tunnel" },
      });
      mocks.callGateway.mockRejectedValue(error);
      await expect(cleanup({ enforce: true, fixMissing: true, json: true })).rejects.toBe(error);

      expect(mocks.runLocalSessionsCleanup).not.toHaveBeenCalled();
      expect(mocks.runSessionsCleanup).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
    },
  );

  it("renders rejected Gateway partial details and exits nonzero", async () => {
    const details = {
      allAgents: true,
      mode: "enforce",
      dryRun: false,
      stores: [
        {
          ...gatewayCleanupResult("/gateway/main/openclaw-agent.sqlite", {
            beforeCount: 1,
            afterCount: 0,
            missing: 1,
            pruned: 0,
            unreferencedArtifacts: {
              scannedFiles: 0,
              removedFiles: 0,
              freedBytes: 0,
              olderThanMs: 0,
            },
          }),
          appliedCount: 0,
        },
      ],
      partialError: {
        failingAgentId: "work",
        failingStorePath: "/gateway/work/openclaw-agent.sqlite",
        message: "Session cleanup failed for agent 'work': injected failure",
        lifecycleCommitted: false,
      },
    };
    mocks.callGateway.mockRejectedValue(Object.assign(new Error("request failed"), { details }));
    await cleanup({ allAgents: true, enforce: true, json: true });

    expect(JSON.parse(logs[0] ?? "{}")).toEqual(details);
    expect(process.exitCode).toBe(1);
    expect(mocks.runLocalSessionsCleanup).not.toHaveBeenCalled();
  });

  it("preserves a Gateway-owned store path in human output", async () => {
    const remoteStorePath = "C:\\Users\\gateway\\.openclaw\\openclaw-agent.sqlite";
    mocks.callGateway.mockResolvedValue(gatewayCleanupResult(remoteStorePath));
    await cleanup({ enforce: true });

    expectLogsToInclude(logs, `Session store: ${remoteStorePath}`);
  });

  it("renders a dry-run action table with keep/archive/prune actions", async () => {
    mockPreviews(
      cleanupPreview(
        {
          beforeCount: 4,
          afterCount: 3,
          archived: 1,
          capArchived: 1,
          pruned: 1,
          capped: 1,
          unreferencedArtifacts: {
            scannedFiles: 5,
            removedFiles: 2,
            freedBytes: 128,
            olderThanMs: 604800000,
          },
        },
        {
          beforeStore: {
            ageArchived: previewEntry("age-archived", 0),
            stale: previewEntry("stale", 1),
            fresh: previewEntry("fresh", 2),
            capArchived: previewEntry("cap-archived", 0),
          },
          staleKeys: new Set(["stale"]),
          ageArchivedKeys: new Set(["ageArchived"]),
          capArchivedKeys: new Set(["capArchived"]),
        },
      ),
    );
    await cleanup({ dryRun: true });

    for (const text of [
      "Session store: /resolved/openclaw-agent.sqlite",
      "Planned session actions:",
      "Would prune unreferenced artifacts: 2",
      "Would archive cap overflow: 1",
      "Would archive inactive sessions: 1",
      "Total: 3 kept, 1 pruned",
    ]) {
      expectLogsToInclude(logs, text);
    }
    const actionKeys = logs
      .flatMap((entry) => stripAnsi(entry).split("\n"))
      .map((line) =>
        line
          .split(/[|│]/u)
          .slice(1, 3)
          .map((cell) => cell.trim()),
      );
    expect(actionKeys).toContainEqual(["Action", "Key"]);
    expect(actionKeys).toContainEqual(["keep", "fresh"]);
    expect(actionKeys).toContainEqual(["prune-stale", "stale"]);
    expect(actionKeys).toContainEqual(["archive-cap", "capArchived"]);
    expect(actionKeys).toContainEqual(["archive-age", "ageArchived"]);
  });

  it("finishes a large distinct-label preview with the normal CLI process stack", () => {
    // A worker's larger stack can hide the argument limit in label-width spreads.
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(sessionsCleanupLargeLabelsEntrypoint)),
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      serviceCalls: 1,
      gridPrinted: true,
      summaryPrinted: true,
      labelRows: 150_000,
      total: "Total: 150000 kept, 0 pruned",
    });
  });

  it("renders a dry-run summary grouped by session label", async () => {
    mockPreviews(
      cleanupPreview(
        {
          beforeCount: 7,
          afterCount: 3,
          pruned: 3,
          capped: 1,
          unreferencedArtifacts: {
            scannedFiles: 0,
            removedFiles: 0,
            freedBytes: 0,
            olderThanMs: 604800000,
          },
        },
        {
          beforeStore: {
            cronKept: previewEntry("cron-kept", 4, "Cron: 🔥修复"),
            cronPruned: previewEntry("cron-pruned", 3, "Cron: 🔥修复"),
            directKept: previewEntry("direct-kept", 2),
            directCapped: previewEntry("direct-capped", 1),
            literalUnlabeled: previewEntry("literal-unlabeled", 1, "Unlabeled"),
            unsafePruned: previewEntry("unsafe-pruned", 1, "\u001b[31mAlert\nInjected"),
            malformedLabelPruned: previewEntry(
              "malformed-label-pruned",
              1,
              {} as unknown as string,
            ),
          },
          staleKeys: new Set(["cronPruned", "unsafePruned", "malformedLabelPruned"]),
          cappedKeys: new Set(["directCapped"]),
        },
      ),
    );
    await cleanup({ dryRun: true });

    expectLogsToInclude(logs, "Summary by Label:");
    const summaryLogs = logs.slice(logs.indexOf("Summary by Label:") + 1);
    const unicodeLine = summaryLogs.find((line) => line.includes("Cron: 🔥修复"));
    const plainLine = summaryLogs.find((line) => line.includes("Unlabeled"));
    expect(unicodeLine).toContain("1 kept, 1 pruned");
    expect(plainLine).toContain("1 kept, 0 pruned");
    const keptColumn = (line: string) => visibleWidth(line.slice(0, line.indexOf("1 kept")));
    expect(keptColumn(unicodeLine ?? "")).toBe(keptColumn(plainLine ?? ""));
    expect(summaryLogs.find((line) => line.includes("(unlabeled)"))).toContain("1 kept, 2 pruned");
    expect(summaryLogs.find((line) => line.includes("Alert\\nInjected"))).toContain(
      "0 kept, 1 pruned",
    );
    expect(logs.join("\n")).not.toContain("\u001b[31m");
    expectLogsToInclude(logs, "Total: 3 kept, 4 pruned");
  });

  it("returns grouped JSON for --all-agents dry-runs", async () => {
    const targets = ["main", "work"].map((agentId) => ({
      agentId,
      storePath: `/resolved/${agentId}-sessions.json`,
    }));
    mocks.resolveCommandSessionStoreTargets.mockReturnValue(targets);
    mockPreviews(
      ...targets.map((target) =>
        cleanupPreview({ ...target, pruned: 1 }, { staleKeys: new Set(["stale"]) }),
      ),
    );
    await cleanup({
      json: true,
      dryRun: true,
      allAgents: true,
    });

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      allAgents: true,
      mode: "warn",
      dryRun: true,
      stores: [
        { ...cleanupPreview({ pruned: 1 }).summary, storePath: "/resolved/main-sessions.sqlite" },
        {
          ...cleanupPreview({ pruned: 1 }).summary,
          agentId: "work",
          storePath: "/resolved/work-sessions.work.sqlite",
        },
      ],
    });
  });
});
