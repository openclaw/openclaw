// Sessions cleanup tests cover stale session cleanup and runtime output.
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi, visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import { GatewayTransportError } from "../gateway/transport-error.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { RuntimeEnv } from "../runtime.js";
import { sessionsCleanupLargeLabelsEntrypoint } from "./sessions-cleanup-runtime.test-support.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveCommandSessionStoreTargets: vi.fn(),
  runSessionsCleanup: vi.fn(),
  runLocalSessionsCleanup: vi.fn(),
  callGateway: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
}));

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

function makeRuntime(): { runtime: RuntimeEnv; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: (msg: unknown) => errors.push(String(msg)),
      exit: () => {},
    },
    logs,
    errors,
  };
}

function expectLogsToInclude(logs: readonly string[], text: string): void {
  const matches = logs.filter((line) => line.includes(text));
  expect(matches.length).toBeGreaterThan(0);
}

function gatewayTransportError(kind: "closed" | "timeout", code?: number): GatewayTransportError {
  return new GatewayTransportError({
    kind,
    code,
    message: `gateway ${kind}`,
    connectionDetails: { url: "ws://127.0.0.1:1", urlSource: "test", message: "test gateway" },
  });
}

function gatewayCleanupResult(storePath: string) {
  return {
    agentId: "main",
    storePath,
    mode: "enforce",
    dryRun: false,
    beforeCount: 3,
    afterCount: 1,
    missing: 0,
    dmScopeRetired: 0,
    modelRunPruned: 0,
    pruned: 2,
    capped: 0,
    diskBudget: null,
    wouldMutate: true,
    applied: true,
    appliedCount: 1,
  } as const;
}

type CleanupPreview = Awaited<
  ReturnType<typeof import("../config/sessions/cleanup-service.js").runSessionsCleanup>
>["previewResults"][number];

function cleanupPreview(
  summary: Partial<CleanupPreview["summary"]>,
  entries: Partial<Omit<CleanupPreview, "summary">> = {},
) {
  return {
    summary: {
      agentId: "main",
      storePath: "/resolved/sessions.json",
      mode: "warn",
      dryRun: true,
      beforeCount: 1,
      afterCount: 0,
      missing: 0,
      dmScopeRetired: 0,
      modelRunPruned: 0,
      pruned: 0,
      capped: 0,
      diskBudget: null,
      wouldMutate: true,
      ...summary,
    },
    beforeStore: {},
    missingKeys: new Set<string>(),
    staleKeys: new Set<string>(),
    cappedKeys: new Set<string>(),
    dmScopeRetiredKeys: new Set<string>(),
    modelRunPrunedKeys: new Set<string>(),
    ...entries,
  };
}

describe("sessionsCleanupCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
    process.exitCode = undefined;
    mocks.runLocalSessionsCleanup.mockImplementation((params) => mocks.runSessionsCleanup(params));
    mocks.loadConfig.mockReturnValue({ session: { store: "/cfg/sessions.json" } });
    mocks.resolveCommandSessionStoreTargets.mockReturnValue([
      { agentId: "main", storePath: "/resolved/sessions.json" },
    ]);
    mocks.callGateway.mockResolvedValue(null);
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "warn",
      previewResults: [],
      appliedSummaries: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps an empty explicit store local instead of delegating default cleanup to the gateway", async () => {
    // Resolve a full result so a regression that delegates fails on the
    // gateway assertion below instead of throwing on the beforeEach null.
    mocks.callGateway.mockResolvedValue(gatewayCleanupResult("/gateway/sessions.json"));
    const { runtime } = makeRuntime();
    await sessionsCleanupCommand({ store: "", enforce: true }, runtime);

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.runSessionsCleanup).toHaveBeenCalledOnce();
    expect(mocks.resolveCommandSessionStoreTargets).toHaveBeenCalledWith(
      expect.objectContaining({ opts: expect.objectContaining({ store: "" }) }),
    );
  });

  it("emits a single JSON object for non-dry runs and applies maintenance", async () => {
    mocks.callGateway.mockRejectedValue(gatewayTransportError("closed"));
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "enforce",
      previewResults: [],
      appliedSummaries: [
        {
          agentId: "main",
          storePath: "/resolved/sessions.json",
          mode: "enforce",
          dryRun: false,
          beforeCount: 3,
          afterCount: 1,
          missing: 0,
          dmScopeRetired: 0,
          modelRunPruned: 0,
          pruned: 0,
          capped: 2,
          diskBudget: {
            totalBytesBefore: 1200,
            totalBytesAfter: 800,
            removedFiles: 0,
            removedEntries: 0,
            freedBytes: 400,
            maxBytes: 1000,
            highWaterBytes: 800,
            overBudget: true,
          },
          wouldMutate: true,
          applied: true,
          appliedCount: 1,
        },
      ],
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        enforce: true,
        activeKey: "agent:main:main",
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      agentId: "main",
      storePath: "/resolved/openclaw-agent.sqlite",
      mode: "enforce",
      dryRun: false,
      beforeCount: 3,
      afterCount: 1,
      missing: 0,
      dmScopeRetired: 0,
      modelRunPruned: 0,
      pruned: 0,
      capped: 2,
      diskBudget: {
        totalBytesBefore: 1200,
        totalBytesAfter: 800,
        removedFiles: 0,
        removedEntries: 0,
        freedBytes: 400,
        maxBytes: 1000,
        highWaterBytes: 800,
        overBudget: true,
      },
      wouldMutate: true,
      applied: true,
      appliedCount: 1,
    });
    expect(mocks.runSessionsCleanup).toHaveBeenCalledOnce();
    const cleanupCall = mocks.runSessionsCleanup.mock.calls[0]?.[0];
    expect(cleanupCall?.cfg).toEqual({ session: { store: "/cfg/sessions.json" } });
    expect(cleanupCall?.opts.enforce).toBe(true);
    expect(cleanupCall?.opts.activeKey).toBe("agent:main:main");
    expect(cleanupCall?.targets).toEqual([
      { agentId: "main", storePath: "/resolved/sessions.json" },
    ]);
  });

  it.each([
    { label: "request timeout after dispatch", error: gatewayTransportError("timeout") },
    { label: "established WebSocket close", error: gatewayTransportError("closed", 1006) },
    { label: "authentication rejection", error: new Error("unauthorized") },
    {
      label: "malformed transport failure",
      error: Object.assign(new Error("malformed transport failure"), {
        name: "GatewayTransportError",
        kind: "closed",
      }),
    },
  ])("surfaces $label without replaying cleanup locally", async ({ error }) => {
    mocks.callGateway.mockRejectedValue(error);

    const { runtime } = makeRuntime();
    await expect(sessionsCleanupCommand({ enforce: true }, runtime)).rejects.toBe(error);

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

      const { runtime, logs } = makeRuntime();
      await expect(
        sessionsCleanupCommand({ enforce: true, fixMissing: true, json: true }, runtime),
      ).rejects.toBe(error);

      expect(mocks.runLocalSessionsCleanup).not.toHaveBeenCalled();
      expect(mocks.runSessionsCleanup).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
    },
  );

  it("delegates non-store enforcing cleanup through the Gateway writer when reachable", async () => {
    const remoteStorePath = "C:\\Users\\gateway\\.openclaw\\agents\\main\\sessions\\sessions.json";
    mocks.loadConfig.mockReturnValue({
      gateway: { mode: "remote", remote: { url: "wss://gateway.example" } },
    });
    mocks.callGateway.mockResolvedValue(gatewayCleanupResult(remoteStorePath));

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        enforce: true,
      },
      runtime,
    );

    expect(mocks.callGateway).toHaveBeenCalledOnce();
    const gatewayCall = mocks.callGateway.mock.calls[0]?.[0];
    expect(gatewayCall?.method).toBe("sessions.cleanup");
    expect(gatewayCall?.params.enforce).toBe(true);
    expect(gatewayCall?.requiredMethods).toEqual(["sessions.cleanup"]);
    expect(mocks.runLocalSessionsCleanup).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      agentId: "main",
      storePath: remoteStorePath,
      mode: "enforce",
      dryRun: false,
      beforeCount: 3,
      afterCount: 1,
      missing: 0,
      dmScopeRetired: 0,
      modelRunPruned: 0,
      pruned: 2,
      capped: 0,
      diskBudget: null,
      wouldMutate: true,
      applied: true,
      appliedCount: 1,
    });
  });

  it("renders rejected Gateway partial details and exits nonzero", async () => {
    const details = {
      allAgents: true,
      mode: "enforce",
      dryRun: false,
      stores: [
        {
          agentId: "main",
          storePath: "/gateway/main/openclaw-agent.sqlite",
          mode: "enforce",
          dryRun: false,
          beforeCount: 1,
          afterCount: 0,
          missing: 1,
          dmScopeRetired: 0,
          modelRunPruned: 0,
          pruned: 0,
          capped: 0,
          unreferencedArtifacts: {
            scannedFiles: 0,
            removedFiles: 0,
            freedBytes: 0,
            olderThanMs: 0,
          },
          diskBudget: null,
          wouldMutate: true,
          applied: true,
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

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand({ allAgents: true, enforce: true, json: true }, runtime);

    expect(JSON.parse(logs[0] ?? "{}")).toEqual(details);
    expect(process.exitCode).toBe(1);
    expect(mocks.runLocalSessionsCleanup).not.toHaveBeenCalled();
  });

  it("does not render rejected Gateway details without a partial marker", async () => {
    const error = Object.assign(new Error("request failed"), {
      details: { allAgents: true, mode: "enforce", dryRun: false, stores: [] },
    });
    mocks.callGateway.mockRejectedValue(error);

    const { runtime } = makeRuntime();
    await expect(sessionsCleanupCommand({ allAgents: true, enforce: true }, runtime)).rejects.toBe(
      error,
    );

    expect(process.exitCode).toBeUndefined();
  });

  it("preserves a Gateway-owned store path in human output", async () => {
    const remoteStorePath = "C:\\Users\\gateway\\.openclaw\\openclaw-agent.sqlite";
    mocks.callGateway.mockResolvedValue(gatewayCleanupResult(remoteStorePath));

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand({ enforce: true }, runtime);

    expectLogsToInclude(logs, `Session store: ${remoteStorePath}`);
  });

  it("returns dry-run JSON without mutating the store", async () => {
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "warn",
      previewResults: [
        cleanupPreview({
          beforeCount: 2,
          afterCount: 1,
          pruned: 1,
          diskBudget: {
            totalBytesBefore: 1000,
            totalBytesAfter: 700,
            removedFiles: 1,
            removedEntries: 1,
            freedBytes: 300,
            maxBytes: 900,
            highWaterBytes: 700,
            overBudget: true,
          },
        }),
      ],
      appliedSummaries: [],
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        dryRun: true,
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      agentId: "main",
      storePath: "/resolved/openclaw-agent.sqlite",
      mode: "warn",
      dryRun: true,
      beforeCount: 2,
      afterCount: 1,
      missing: 0,
      dmScopeRetired: 0,
      modelRunPruned: 0,
      pruned: 1,
      capped: 0,
      diskBudget: {
        totalBytesBefore: 1000,
        totalBytesAfter: 700,
        removedFiles: 1,
        removedEntries: 1,
        freedBytes: 300,
        maxBytes: 900,
        highWaterBytes: 700,
        overBudget: true,
      },
      wouldMutate: true,
    });
    expect(mocks.runSessionsCleanup).toHaveBeenCalled();
    expect(mocks.runLocalSessionsCleanup).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("renders a dry-run action table with keep/archive/prune actions", async () => {
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "warn",
      previewResults: [
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
              ageArchived: { sessionId: "age-archived", updatedAt: 0, model: "test:opus" },
              stale: { sessionId: "stale", updatedAt: 1, model: "test:opus" },
              fresh: { sessionId: "fresh", updatedAt: 2, model: "test:opus" },
              capArchived: { sessionId: "cap-archived", updatedAt: 0, model: "test:opus" },
            },
            staleKeys: new Set(["stale"]),
            ageArchivedKeys: new Set(["ageArchived"]),
            capArchivedKeys: new Set(["capArchived"]),
          },
        ),
      ],
      appliedSummaries: [],
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        dryRun: true,
      },
      runtime,
    );

    expectLogsToInclude(logs, "Session store: /resolved/openclaw-agent.sqlite");
    expectLogsToInclude(logs, "Planned session actions:");
    expectLogsToInclude(logs, "Would prune unreferenced artifacts: 2");
    expectLogsToInclude(logs, "Would archive cap overflow: 1");
    expectLogsToInclude(logs, "Would archive inactive sessions: 1");
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
    expectLogsToInclude(logs, "Total: 3 kept, 1 pruned");
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
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "warn",
      previewResults: [
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
              cronKept: {
                sessionId: "cron-kept",
                updatedAt: 4,
                model: "test:opus",
                label: "Cron: daily-commit",
              },
              cronPruned: {
                sessionId: "cron-pruned",
                updatedAt: 3,
                model: "test:opus",
                label: "Cron: daily-commit",
              },
              directKept: {
                sessionId: "direct-kept",
                updatedAt: 2,
                model: "test:opus",
              },
              directCapped: {
                sessionId: "direct-capped",
                updatedAt: 1,
                model: "test:opus",
              },
              literalUnlabeled: {
                sessionId: "literal-unlabeled",
                updatedAt: 1,
                model: "test:opus",
                label: "Unlabeled",
              },
              unsafePruned: {
                sessionId: "unsafe-pruned",
                updatedAt: 1,
                model: "test:opus",
                label: "\u001b[31mAlert\nInjected",
              },
              malformedLabelPruned: {
                sessionId: "malformed-label-pruned",
                updatedAt: 1,
                model: "test:opus",
                label: {} as unknown as string,
              },
            },
            staleKeys: new Set(["cronPruned", "unsafePruned", "malformedLabelPruned"]),
            cappedKeys: new Set(["directCapped"]),
          },
        ),
      ],
      appliedSummaries: [],
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        dryRun: true,
      },
      runtime,
    );

    expectLogsToInclude(logs, "Summary by Label:");
    const summaryLogs = logs.slice(logs.indexOf("Summary by Label:") + 1);
    expectLogsToInclude(logs, "Cron: daily-commit  1 kept, 1 pruned");
    expect(summaryLogs.find((line) => line.includes("(unlabeled)"))).toContain("1 kept, 2 pruned");
    expect(summaryLogs.find((line) => line.includes("Unlabeled"))).toContain("1 kept, 0 pruned");
    expect(summaryLogs.find((line) => line.includes("Alert\\nInjected"))).toContain(
      "0 kept, 1 pruned",
    );
    expect(logs.join("\n")).not.toContain("\u001b[31m");
    expectLogsToInclude(logs, "Total: 3 kept, 4 pruned");
  });

  it("aligns the label summary columns for emoji and CJK labels", async () => {
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "warn",
      previewResults: [
        cleanupPreview(
          {
            beforeCount: 2,
            afterCount: 2,
            unreferencedArtifacts: {
              scannedFiles: 0,
              removedFiles: 0,
              freedBytes: 0,
              olderThanMs: 604800000,
            },
          },
          {
            beforeStore: {
              emojiKept: {
                sessionId: "emoji-kept",
                updatedAt: 2,
                model: "test:opus",
                label: "🔥修复",
              },
              plainKept: {
                sessionId: "plain-kept",
                updatedAt: 1,
                model: "test:opus",
                label: "plain",
              },
            },
          },
        ),
      ],
      appliedSummaries: [],
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        dryRun: true,
      },
      runtime,
    );

    expectLogsToInclude(logs, "Summary by Label:");
    const summaryLogs = logs.slice(logs.indexOf("Summary by Label:") + 1);
    const emojiLine = summaryLogs.find((line) => line.includes("🔥修复"));
    const plainLine = summaryLogs.find((line) => line.includes("plain"));
    expect(emojiLine).toBeDefined();
    expect(plainLine).toBeDefined();
    // "🔥修复" is 6 visible columns (wide emoji + 2 CJK) but only 5 UTF-16 code
    // units; padding by code-unit length would shift the counts column left.
    const keptColumn = (line: string) => visibleWidth(line.slice(0, line.indexOf("1 kept")));
    expect(keptColumn(emojiLine ?? "")).toBe(keptColumn(plainLine ?? ""));
  });

  it("returns grouped JSON for --all-agents dry-runs", async () => {
    mocks.resolveCommandSessionStoreTargets.mockReturnValue([
      { agentId: "main", storePath: "/resolved/main-sessions.json" },
      { agentId: "work", storePath: "/resolved/work-sessions.json" },
    ]);
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "warn",
      previewResults: [
        cleanupPreview(
          {
            storePath: "/resolved/main-sessions.json",
            pruned: 1,
          },
          {
            staleKeys: new Set(["stale"]),
          },
        ),
        cleanupPreview(
          {
            agentId: "work",
            storePath: "/resolved/work-sessions.json",
            pruned: 1,
          },
          {
            staleKeys: new Set(["stale"]),
          },
        ),
      ],
      appliedSummaries: [],
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        dryRun: true,
        allAgents: true,
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      allAgents: true,
      mode: "warn",
      dryRun: true,
      stores: [
        {
          agentId: "main",
          storePath: "/resolved/main-sessions.sqlite",
          mode: "warn",
          dryRun: true,
          beforeCount: 1,
          afterCount: 0,
          missing: 0,
          dmScopeRetired: 0,
          modelRunPruned: 0,
          pruned: 1,
          capped: 0,
          diskBudget: null,
          wouldMutate: true,
        },
        {
          agentId: "work",
          storePath: "/resolved/work-sessions.work.sqlite",
          mode: "warn",
          dryRun: true,
          beforeCount: 1,
          afterCount: 0,
          missing: 0,
          dmScopeRetired: 0,
          modelRunPruned: 0,
          pruned: 1,
          capped: 0,
          diskBudget: null,
          wouldMutate: true,
        },
      ],
    });
  });
});
