import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it as test, vi } from "vitest";
import * as configEnv from "../config/config-env-vars.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { resolveSqliteTranscriptScope } from "../config/sessions/session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction as append } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { unregisterOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction as write,
} from "../state/openclaw-agent-db.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { refreshCostUsageCacheForAgent as refresh } from "./session-cost-usage-aggregation.js";
import { resolveUsageCostPricingFingerprint as fingerprint } from "./session-cost-usage-pricing-context.js";
import {
  prepareUsageCostWorker as prepare,
  runUsageCostWorker as run,
} from "./session-cost-usage-worker-runtime.js";
import { loadSessionCostSummariesFromCache as read } from "./session-cost-usage.js";
import * as operationAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

const usageEvent = {
  type: "message",
  id: "usage",
  parentId: null,
  timestamp: "2026-09-18T00:00:00Z",
  message: {
    role: "assistant",
    usage: { input: 7, output: 3, totalTokens: 10, cost: { total: 1 } },
  },
};
const totals = { totalTokens: 10, totalCost: 1 };
type Scope = { agentId: string; env: NodeJS.ProcessEnv };
type UsageFixture = { state: OpenClawTestState; scope: Scope };
const it = test.extend<{ layout: "home" | "split"; usage: UsageFixture }>({
  layout: "home",
  usage: async ({ layout }, use) =>
    withOpenClawTestState({ scenario: "minimal", layout }, (state) =>
      use({ state, scope: { agentId: "main", env: state.env } }),
    ),
});
function store(state: OpenClawTestState, name: string) {
  const dir = state.path(name);
  fs.mkdirSync(dir, { recursive: true });
  return {
    storePath: path.join(dir, "sessions.json"),
    databasePath: path.join(dir, "openclaw-agent.sqlite"),
    sessionFile: path.join(dir, "recorded.jsonl"),
  };
}
function open(scope: Scope, file: string, agentId = scope.agentId) {
  return openOpenClawAgentDatabase({ ...scope, agentId, path: file });
}
async function refreshed(params: Parameters<typeof refresh>[0]) {
  await expect(refresh(params)).resolves.toBe("refreshed");
}
async function expectSummary(sessionFile: string, config = {}, agentId = "main") {
  const params = { agentId, config, sessions: [{ sessionFile }], requestRefresh: false };
  await expect(read(params)).resolves.toMatchObject({ summaries: [totals] });
}
function writeUsage(sessionFile: string) {
  fs.writeFileSync(sessionFile, JSON.stringify(usageEvent) + "\n");
}

test("refuses a foreign cache file appearing after its creating grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config = {};
    const agentId = "usage-foreign-creation";
    const sessionFile = state.path("usage.jsonl");
    writeUsage(sessionFile);
    const prepared = prepare({ config, agentId, sessionFiles: [sessionFile] });
    const target = prepared.location.databasePath;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let injected = false;
    const observer = probe.admission(operationAdmission, (request, grant, authorize) => {
      authorize(request, () => {
        if (
          !injected &&
          request.stage === "prepare" &&
          isRecord(request.facts) &&
          request.facts.kind === "shared-owner"
        ) {
          fs.writeFileSync(target, "foreign file");
          injected = true;
        }
        return grant();
      });
    });
    try {
      await expect(refresh({ config, agentId, sessionFiles: [sessionFile] })).rejects.toThrow(
        "Agent database target changed before creating open",
      );
      expect(injected).toBe(true);
      expect(await fs.promises.readFile(target, "utf8")).toBe("foreign file");
    } finally {
      observer.mockRestore();
    }
  });
});

it("refreshes retained colon session IDs", async ({ usage: { scope } }) => {
  const database = openOpenClawAgentDatabase(scope);
  const transcript = resolveSqliteTranscriptScope({
    ...scope,
    sessionKey: "agent:main:retained-usage",
    sessionId: "legacy:session",
    storePath: database.path,
  });
  const events = [{ type: "session", version: 1, id: transcript.sessionId }, usageEvent];
  const options = { scheduleProjectionReconcile: false };
  write((owner) => append(owner, transcript, events, options), { ...scope, path: database.path });
  await refreshed({ ...scope, config: {} });
  await expectSummary(`sqlite:main:legacy:session:${database.path}`);
});

it("inventories retained usage by transcript recency and logical agent after writes", async ({
  usage: { state, scope },
}) => {
  const storePath = state.path("shared.sqlite");
  const database = open(scope, storePath);
  const appendUsage = (
    agentId: string,
    sessionId: string,
    sessionKey: string,
    updatedAt: number,
  ) => {
    const transcript = resolveSqliteTranscriptScope({
      ...scope,
      agentId,
      sessionId,
      sessionKey,
      storePath,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(updatedAt);
    try {
      write(
        (owner) =>
          append(
            owner,
            transcript,
            [{ type: "message", id: `${sessionId}-${updatedAt}`, message: { role: "user" } }],
            { scheduleProjectionReconcile: false },
          ),
        { ...scope, path: database.path },
      );
    } finally {
      clock.mockRestore();
    }
  };
  appendUsage("main", "old", "agent:main:old", 1000);
  appendUsage("main", "second", "agent:main:second", 2000);
  appendUsage("main", "first", "agent:main:first", 2000);
  appendUsage("main", "hidden", "agent:main:internal-session-effects:hidden", 3000);
  appendUsage("other", "other", "agent:other:other", 3000);
  write(
    (owner) => {
      writeSessionEntry(owner, "agent:main:metadata-only", {
        sessionId: "metadata-only",
        updatedAt: 9000,
      });
    },
    { ...scope, path: database.path },
  );
  const prepared = prepare({ ...scope, storePath });
  await expect(run(prepared, { kind: "inventory" })).resolves.toMatchObject({
    kind: "inventory",
    files: [
      { sessionId: "first", mtimeMs: 2000 },
      { sessionId: "second", mtimeMs: 2000 },
      { sessionId: "old", mtimeMs: 1000 },
    ],
  });
  await expect(run(prepared, { kind: "inventory", minMtimeMs: 2000 })).resolves.toMatchObject({
    kind: "inventory",
    files: [
      { sessionId: "first", mtimeMs: 2000 },
      { sessionId: "second", mtimeMs: 2000 },
    ],
  });
  // The smallest transcript is oldest: refresh priority is independent of inventory recency.
  await expect(
    run(prepared, {
      kind: "refresh",
      maxFiles: 1,
    }),
  ).resolves.toMatchObject({
    kind: "refresh",
    changed: true,
    remainingFiles: [
      { sessionFile: expect.stringContaining(":first:") },
      { sessionFile: expect.stringContaining(":second:") },
    ],
  });
  appendUsage("main", "old", "agent:main:old", 4000);
  await expect(run(prepared, { kind: "inventory", minMtimeMs: 2000 })).resolves.toMatchObject({
    kind: "inventory",
    files: [
      { sessionId: "old", mtimeMs: 4000 },
      { sessionId: "first", mtimeMs: 2000 },
      { sessionId: "second", mtimeMs: 2000 },
    ],
  });
});

it("keeps SQLite selectors distinct", async ({ usage: { state, scope } }) => {
  const { storePath, databasePath } = store(state, "custom");
  open(scope, databasePath);
  const sessionFiles = ["first", "second"].map((id) => `sqlite:main:${id}:${storePath}`);
  const prepared = prepare({ ...scope, storePath, sessionFiles });
  await expect(run(prepared, { kind: "inventory", sessionFiles })).resolves.toMatchObject({
    kind: "inventory",
    files: sessionFiles.map((sourcePath) => ({ kind: "sqlite", sourcePath })),
  });
});

it("refreshes replaced store owners", async ({ usage: { state, scope } }) => {
  const { storePath, databasePath, sessionFile } = store(state, "custom");
  open(scope, databasePath);
  open(scope, state.path("custom", "openclaw-agent.main.sqlite"));
  await refresh({ ...scope, storePath: store(state, "warm").storePath });
  await closeOpenClawAgentDatabaseByPathAsync(databasePath);
  unregisterOpenClawAgentDatabase({ ...scope, path: databasePath });
  fs.unlinkSync(databasePath);
  open(scope, databasePath, "other");
  writeUsage(sessionFile);
  await refreshed({ ...scope, storePath, maxFiles: 1 });
  await expectSummary(sessionFile, { session: { store: storePath } });
});

it("captures inventory sibling custody", async ({ usage: { state, scope } }) => {
  const { storePath, sessionFile } = store(state, "usage-store");
  fs.writeFileSync(sessionFile, "{}\n");
  const prepared = prepare({ ...scope, storePath });
  open(scope, state.path("usage-store", "openclaw-agent.other.sqlite"), "other");
  await expect(run(prepared, { kind: "inventory" })).resolves.toMatchObject({
    kind: "inventory",
    files: [{ kind: "jsonl", sourcePath: sessionFile }],
  });
});

it.extend({ layout: "split" })("captures Windows state", async ({ usage }) => {
  const { state } = usage;
  const scope = { agentId: "usage-env", env: state.env };
  const sessionFile = state.path("usage.jsonl");
  writeUsage(sessionFile);
  const databasePath = resolveOpenClawAgentSqlitePath(scope);
  const laterRoot = state.path("later-state");
  const original = { env: process.env, platform: process.platform };
  const cloneEnv = configEnv.cloneEnvWithPlatformSemantics;
  const clone = vi
    .spyOn(configEnv, "cloneEnvWithPlatformSemantics")
    .mockImplementation((input) => withMockedPlatform("win32", () => cloneEnv(input)));
  try {
    const params = { agentId: scope.agentId, config: {}, sessionFiles: [sessionFile] };
    await refreshed(params);
    const env = Object.fromEntries(
      Object.entries(state.env).filter(([key]) => key.toUpperCase() !== "OPENCLAW_STATE_DIR"),
    );
    env.OpenClaw_State_Dir = state.stateDir;
    const prepared = prepare({ ...params, env });
    expect(prepared.location.databasePath).toBe(databasePath);
    const pricingFingerprint = await fingerprint(prepared.config, prepared.agentDir);
    env.OpenClaw_State_Dir = laterRoot;
    process.env = { ...original.env, OPENCLAW_STATE_DIR: laterRoot };
    expect(process.platform).toBe(original.platform);
    const result = await run(prepared, {
      kind: "sessions",
      pricingFingerprint,
      sessions: [{ sessionFile }],
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
    });
    expect(result).toMatchObject({
      kind: "sessions",
      summaries: [totals],
      cacheStatus: { status: "fresh", cachedFiles: 1 },
    });
    process.env = original.env;
    await expectSummary(sessionFile, {}, scope.agentId);
    const roots = [databasePath, path.join(state.home, ".openclaw"), laterRoot];
    expect(roots.map(fs.existsSync)).toEqual([true, false, false]);
  } finally {
    process.env = original.env;
    clone.mockRestore();
  }
});
