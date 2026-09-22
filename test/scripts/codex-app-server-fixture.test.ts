import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeThreadStartResponse } from "../../scripts/e2e/lib/codex-app-server-fixture.mjs";
import { findCodexFixtureTurnAccountEvidence } from "../e2e/qa-lab/runtime/codex-auth-product-proof.test-support.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("createFakeThreadStartResponse", () => {
  it.each([
    { expected: null, params: {} },
    { expected: "project-1", params: { projectId: "project-1" } },
  ])("returns the protocol-required projectId as $expected", ({ expected, params }) => {
    const response = createFakeThreadStartResponse({
      params,
      sessionId: "session-1",
      threadId: "thread-1",
      version: "0.149.1",
    });

    expect(response.thread.projectId).toBe(expected);
  });
});

type AuthFixtureThread = {
  id: string;
  cwd: string;
  ephemeral: boolean;
  createdAt: number;
  status: { type: string };
  turns: Array<{ id: string; items: unknown[] }>;
};

type AuthFixtureMessage = {
  id?: number;
  method?: string;
  result?: { thread?: AuthFixtureThread; status?: string; model?: string };
  params?: {
    threadId?: string;
    status?: { type: string };
    turn?: { id: string; items: unknown[] };
  };
};

function runAuthFixture(requestLog: string, requests: Array<Record<string, unknown>>) {
  const child = spawnSync(
    process.execPath,
    ["test/e2e/qa-lab/runtime/codex-auth-app-server.fixture.mjs"],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        OPENCLAW_QA_CODEX_APP_SERVER_VERSION: "0.154.0",
        OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG: requestLog,
      },
      input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  const messages: AuthFixtureMessage[] = child.stdout.trim()
    ? child.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { ...child, messages };
}

function seedAuthFixture() {
  const workspace = tempDirs.make("codex-fixture-thread-");
  const requestLog = path.join(workspace, "requests.jsonl");
  const started = runAuthFixture(requestLog, [
    { id: 1, method: "thread/start", params: { cwd: workspace } },
    { id: 2, method: "thread/start", params: { cwd: workspace, ephemeral: true } },
  ]);
  expect(started.status, started.stderr).toBe(0);
  const durable = started.messages.find((message) => message.id === 1)?.result?.thread;
  const ephemeral = started.messages.find((message) => message.id === 2)?.result?.thread;
  expect(durable).toBeDefined();
  expect(ephemeral).toBeDefined();
  return { requestLog, workspace, durable: durable!, ephemeral: ephemeral! };
}

describe("auth fixture thread lifecycle", () => {
  it("gives durable and ephemeral starts distinct identities", () => {
    const { durable, ephemeral } = seedAuthFixture();
    expect(durable.id).not.toBe(ephemeral.id);
    expect(durable.ephemeral).toBe(false);
    expect(ephemeral.ephemeral).toBe(true);
  });

  it("restores a cold durable thread and keeps completed turns distinct across processes", () => {
    const { requestLog, workspace, durable } = seedAuthFixture();
    const firstTurn = runAuthFixture(requestLog, [
      { id: 1, method: "thread/resume", params: { threadId: durable.id, cwd: workspace } },
      { id: 2, method: "turn/start", params: { threadId: durable.id } },
    ]);
    expect(firstTurn.status, firstTurn.stderr).toBe(0);
    const completed = firstTurn.messages.find((message) => message.method === "turn/completed")
      ?.params?.turn;
    expect(completed).toBeDefined();
    const secondTurn = runAuthFixture(requestLog, [
      { id: 1, method: "thread/read", params: { threadId: durable.id, includeTurns: true } },
      { id: 2, method: "thread/read", params: { threadId: durable.id, includeTurns: false } },
      { id: 3, method: "thread/resume", params: { threadId: durable.id, cwd: workspace } },
      { id: 4, method: "turn/start", params: { threadId: durable.id } },
    ]);
    expect(secondTurn.status, secondTurn.stderr).toBe(0);
    expect(secondTurn.messages.find((message) => message.id === 1)?.result?.thread).toMatchObject({
      id: durable.id,
      cwd: workspace,
      createdAt: durable.createdAt,
      ephemeral: false,
      status: { type: "notLoaded" },
      turns: [completed],
    });
    expect(secondTurn.messages.find((message) => message.id === 2)?.result?.thread?.turns).toEqual(
      [],
    );
    expect(secondTurn.messages.find((message) => message.id === 3)?.result?.thread).toMatchObject({
      id: durable.id,
      cwd: workspace,
      status: { type: "idle" },
      turns: [completed],
    });
    const next = secondTurn.messages.find((message) => message.method === "turn/completed")?.params
      ?.turn;
    expect(next).toBeDefined();
    expect(next?.id).not.toBe(completed?.id);
    const read = runAuthFixture(requestLog, [
      { id: 1, method: "thread/read", params: { threadId: durable.id, includeTurns: true } },
    ]);
    expect(read.status, read.stderr).toBe(0);
    expect(read.messages[0]?.result?.thread?.turns).toEqual([completed, next]);
  });

  it.each(["unknown", "ephemeral", "corrupt"])("rejects %s cold thread recovery", (kind) => {
    const { requestLog, durable, ephemeral } = seedAuthFixture();
    if (kind === "corrupt") {
      fs.appendFileSync(requestLog, "{\n");
    }
    const threadId =
      kind === "unknown" ? "unknown-thread" : kind === "ephemeral" ? ephemeral.id : durable.id;
    const read = runAuthFixture(requestLog, [
      { id: 1, method: "thread/read", params: { threadId, includeTurns: false } },
    ]);
    expect(read.status, read.stderr).toBe(1);
    expect(read.stderr).toContain("Cannot restore synthetic Codex thread");
  });

  it("retains an unsubscribed loaded thread until full-config resume actually reloads it", () => {
    const { requestLog, durable, workspace } = seedAuthFixture();
    const run = runAuthFixture(requestLog, [
      { id: 1, method: "thread/resume", params: { threadId: durable.id, cwd: workspace } },
      { id: 2, method: "thread/unsubscribe", params: { threadId: durable.id } },
      { id: 3, method: "thread/read", params: { threadId: durable.id } },
      { id: 4, method: "thread/unsubscribe", params: { threadId: durable.id } },
      {
        id: 5,
        method: "thread/resume",
        params: { threadId: durable.id, cwd: workspace, config: {} },
      },
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.messages.find((message) => message.id === 2)?.result).toEqual({
      status: "unsubscribed",
    });
    expect(run.messages.find((message) => message.id === 3)?.result?.thread?.status).toEqual({
      type: "idle",
    });
    expect(run.messages.find((message) => message.id === 4)?.result).toEqual({
      status: "notSubscribed",
    });
    const unloaded = run.messages.findIndex(
      (message) =>
        message.method === "thread/status/changed" && message.params?.status?.type === "notLoaded",
    );
    expect(unloaded).toBeGreaterThan(run.messages.findIndex((message) => message.id === 4));
    expect(unloaded).toBeLessThan(run.messages.findIndex((message) => message.id === 5));
  });

  it.each([false, true])(
    "does not invent an unload for a subscribed thread (active=%s)",
    (active) => {
      const { requestLog, durable, workspace } = seedAuthFixture();
      const run = runAuthFixture(requestLog, [
        { id: 1, method: "thread/resume", params: { threadId: durable.id, cwd: workspace } },
        ...(active ? [{ id: 2, method: "turn/start", params: { threadId: durable.id } }] : []),
        {
          id: 3,
          method: "thread/resume",
          params: { threadId: durable.id, model: "ignored-model", config: {} },
        },
      ]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.messages.find((message) => message.id === 3)?.result?.model).toBe("gpt-5.6-luna");
      expect(run.messages.find((message) => message.id === 3)?.result?.thread?.status.type).toBe(
        active ? "active" : "idle",
      );
      if (active) {
        expect(
          run.messages.findIndex((message) => message.method === "turn/completed"),
        ).toBeGreaterThan(run.messages.findIndex((message) => message.id === 3));
      }
      expect(
        run.messages.filter(
          (message) =>
            message.method === "thread/status/changed" &&
            message.params?.status?.type === "notLoaded",
        ),
      ).toEqual([]);
    },
  );
});

describe("fake Codex configuration preflight", () => {
  it.each([
    ["auth", "test/e2e/qa-lab/runtime/codex-auth-app-server.fixture.mjs"],
    ["approval", "test/e2e/qa-lab/runtime/codex-native-approval-app-server.fixture.mjs"],
    ["media", "scripts/e2e/lib/codex-media-path/fake-codex-app-server.mjs"],
  ])("%s exposes empty effective config and no managed requirements", (_name, fixture) => {
    const requestLog = path.join(tempDirs.make("codex-fixture-config-"), "requests.jsonl");
    const result = spawnSync(process.execPath, [fixture], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_QA_CODEX_APP_SERVER_VERSION: "0.153.0",
        OPENCLAW_QA_CODEX_AUTH_APP_SERVER_LOG: requestLog,
        OPENCLAW_QA_CODEX_NATIVE_APPROVAL_LOG: requestLog,
        OPENCLAW_CODEX_MEDIA_PATH_APP_SERVER_LOG: requestLog,
      },
      input:
        [
          { id: 1, method: "config/read", params: { cwd: process.cwd(), includeLayers: true } },
          { id: 2, method: "configRequirements/read" },
        ]
          .map((request) => JSON.stringify(request))
          .join("\n") + "\n",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { id: 1, result: { config: {}, origins: {}, layers: [] } },
      { id: 2, result: { requirements: null } },
    ]);
  });
});

type FixtureAuthOperation = {
  version: number;
  instanceId: string;
  sequence: number;
  operation: string;
  account: { type: string; accountId?: string } | null;
  threadId?: string;
  turnId?: string;
};
type FixtureAuthLogEntry = { fixtureAuthOperation?: FixtureAuthOperation };

const FIXTURE_ACCOUNT_A = "qa-codex-configured-account";
const FIXTURE_ACCOUNT_B = "qa-codex-account";

function readFixtureAuthLog(requestLog: string): FixtureAuthLogEntry[] {
  return fs
    .readFileSync(requestLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureAuthLogEntry);
}

function fixtureLogin(accountId: string) {
  return {
    id: 1,
    method: "account/login/start",
    params: {
      type: "chatgptAuthTokens",
      accessToken: `fixture-secret-${accountId}`,
      chatgptAccountId: accountId,
    },
  };
}

function seedAuthEvidenceThreads(count = 1) {
  const workspace = tempDirs.make("codex-fixture-auth-state-");
  const requestLog = path.join(workspace, "requests.jsonl");
  const seed = runAuthFixture(
    requestLog,
    Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      method: "thread/start",
      params: { cwd: workspace },
    })),
  );
  expect(seed.status, seed.stderr).toBe(0);
  const threadIds = Array.from({ length: count }, (_, index) => {
    const id = seed.messages.find((message) => message.id === index + 1)?.result?.thread?.id;
    expect(id).toEqual(expect.stringMatching(/\S/));
    return id!;
  });
  return { requestLog, workspace, threadIds };
}

function runAuthEvidence(requestLog: string, requests: Array<Record<string, unknown>>) {
  const afterIndex = readFixtureAuthLog(requestLog).length;
  const result = runAuthFixture(requestLog, requests);
  expect(result.status, result.stderr).toBe(0);
  return { result, afterIndex, entries: readFixtureAuthLog(requestLog) };
}

function authOperations(entries: readonly FixtureAuthLogEntry[]) {
  return entries.flatMap((entry) =>
    entry.fixtureAuthOperation ? [entry.fixtureAuthOperation] : [],
  );
}

describe("auth fixture active-account evidence", () => {
  it("proves warm account reuse without another login or thread setup after the cursor", () => {
    const { requestLog, threadIds } = seedAuthEvidenceThreads(2);
    const firstThread = threadIds[0]!;
    const secondThread = threadIds[1]!;
    const run = runAuthEvidence(requestLog, [
      fixtureLogin(FIXTURE_ACCOUNT_A),
      { id: 2, method: "thread/resume", params: { threadId: firstThread } },
      { id: 3, method: "turn/start", params: { threadId: firstThread } },
      { id: 4, method: "thread/resume", params: { threadId: secondThread } },
      { id: 5, method: "turn/start", params: { threadId: secondThread } },
    ]);
    const first = findCodexFixtureTurnAccountEvidence(run.entries, {
      afterIndex: run.afterIndex,
      threadId: firstThread,
      accountId: FIXTURE_ACCOUNT_A,
    });
    const second = findCodexFixtureTurnAccountEvidence(run.entries, {
      afterIndex: run.afterIndex,
      threadId: secondThread,
      accountId: FIXTURE_ACCOUNT_A,
    });
    expect(first).toMatchObject({
      threadId: firstThread,
      account: { type: "chatgptAuthTokens", accountId: "qa-codex-configured-account" },
    });
    expect(second).toMatchObject({
      threadId: secondThread,
      account: { type: "chatgptAuthTokens", accountId: "qa-codex-configured-account" },
    });
    expect(second!.instanceId).toBe(first!.instanceId);
    expect(second!.turnId).not.toBe(first!.turnId);
    const operations = authOperations(run.entries).filter(
      (row) => row.instanceId === first!.instanceId,
    );
    expect(operations.filter((row) => row.operation === "auth_applied")).toHaveLength(1);
    const turnIndex = run.entries.findIndex(
      (row) =>
        row.fixtureAuthOperation?.threadId === secondThread &&
        row.fixtureAuthOperation.operation === "turn_started",
    );
    expect(turnIndex).toBeGreaterThan(run.afterIndex);
    expect(
      findCodexFixtureTurnAccountEvidence(run.entries, {
        afterIndex: turnIndex,
        threadId: secondThread,
        accountId: FIXTURE_ACCOUNT_A,
      }),
    ).toEqual(second);
    expect(
      operations.every(
        (row, index) => index === 0 || row.sequence > operations[index - 1]!.sequence,
      ),
    ).toBe(true);
    for (const row of operations) {
      expect(row.instanceId).toEqual(expect.stringMatching(/\S/));
      expect(Object.keys(row.account ?? {}).toSorted()).toEqual(["accountId", "type"]);
    }
    const safeEvidence = JSON.stringify(operations);
    expect(safeEvidence).not.toContain(`fixture-secret-${FIXTURE_ACCOUNT_A}`);
    expect(safeEvidence).not.toContain(`fixture-secret-${FIXTURE_ACCOUNT_B}`);
  });

  it.each(["wrong", "missing"] as const)(
    "rejects %s active auth instead of borrowing an earlier process login",
    (kind) => {
      const { requestLog, threadIds } = seedAuthEvidenceThreads();
      const threadId = threadIds[0]!;
      const prior = runAuthEvidence(requestLog, [
        fixtureLogin(FIXTURE_ACCOUNT_A),
        { id: 2, method: "thread/resume", params: { threadId } },
        { id: 3, method: "turn/start", params: { threadId } },
      ]);
      const previous = findCodexFixtureTurnAccountEvidence(prior.entries, {
        afterIndex: prior.afterIndex,
        threadId,
        accountId: FIXTURE_ACCOUNT_A,
      });
      expect(previous).toBeDefined();
      const run = runAuthEvidence(requestLog, [
        ...(kind === "wrong" ? [fixtureLogin(FIXTURE_ACCOUNT_B)] : []),
        { id: 2, method: "account/read" },
        { id: 3, method: "thread/resume", params: { threadId } },
        { id: 4, method: "turn/start", params: { threadId } },
      ]);
      expect(
        findCodexFixtureTurnAccountEvidence(run.entries, {
          afterIndex: run.afterIndex,
          threadId,
          accountId: FIXTURE_ACCOUNT_A,
        }),
      ).toBeUndefined();
      const accepted = authOperations(run.entries.slice(run.afterIndex)).find(
        (row) => row.operation === "turn_started",
      );
      expect(accepted).toBeDefined();
      expect(accepted!.instanceId).not.toBe(previous!.instanceId);
      if (kind === "wrong") {
        expect(
          findCodexFixtureTurnAccountEvidence(run.entries, {
            afterIndex: run.afterIndex,
            threadId,
            accountId: FIXTURE_ACCOUNT_B,
          }),
        ).toMatchObject({
          account: { type: "chatgptAuthTokens", accountId: "qa-codex-account" },
        });
      } else {
        expect(accepted!.account).toBeNull();
        expect(run.result.messages.find((message) => message.id === 2)?.result).toMatchObject({
          account: null,
        });
      }
    },
  );

  it("retains the accepted account when login changes before asynchronous completion", () => {
    const { requestLog, threadIds } = seedAuthEvidenceThreads();
    const threadId = threadIds[0]!;
    const run = runAuthEvidence(requestLog, [
      fixtureLogin(FIXTURE_ACCOUNT_B),
      { id: 2, method: "thread/resume", params: { threadId } },
      { id: 3, method: "turn/start", params: { threadId } },
      { ...fixtureLogin(FIXTURE_ACCOUNT_A), id: 4 },
    ]);
    expect(
      findCodexFixtureTurnAccountEvidence(run.entries, {
        afterIndex: run.afterIndex,
        threadId,
        accountId: FIXTURE_ACCOUNT_B,
      }),
    ).toMatchObject({
      account: { type: "chatgptAuthTokens", accountId: "qa-codex-account" },
    });
    expect(
      findCodexFixtureTurnAccountEvidence(run.entries, {
        afterIndex: run.afterIndex,
        threadId,
        accountId: FIXTURE_ACCOUNT_A,
      }),
    ).toBeUndefined();
    const operations = authOperations(run.entries.slice(run.afterIndex));
    const latestLogin = operations.findLast((row) => row.operation === "auth_applied")!;
    const completed = operations.find((row) => row.operation === "turn_completed")!;
    const started = operations.find((row) => row.operation === "turn_started")!;
    expect(started.instanceId).toBe(latestLogin.instanceId);
    expect(completed.instanceId).toBe(started.instanceId);
    expect(started.sequence).toBeLessThan(latestLogin.sequence);
    expect(latestLogin.account).toEqual({
      type: "chatgptAuthTokens",
      accountId: "qa-codex-configured-account",
    });
    expect(completed.account).toEqual({
      type: "chatgptAuthTokens",
      accountId: "qa-codex-account",
    });
    expect(latestLogin.sequence).toBeLessThan(completed.sequence);
  });

  it("clears active auth on logout without restoring it from durable thread history", () => {
    const { requestLog, threadIds } = seedAuthEvidenceThreads();
    const threadId = threadIds[0]!;
    const run = runAuthEvidence(requestLog, [
      fixtureLogin(FIXTURE_ACCOUNT_A),
      { id: 2, method: "account/logout" },
      { id: 3, method: "account/read" },
      { id: 4, method: "thread/resume", params: { threadId } },
      { id: 5, method: "turn/start", params: { threadId } },
    ]);
    expect(run.result.messages.find((message) => message.id === 3)?.result).toMatchObject({
      account: null,
    });
    expect(
      authOperations(run.entries.slice(run.afterIndex)).find(
        (row) => row.operation === "auth_cleared",
      )?.account,
    ).toBeNull();
    expect(
      findCodexFixtureTurnAccountEvidence(run.entries, {
        afterIndex: run.afterIndex,
        threadId,
        accountId: FIXTURE_ACCOUNT_A,
      }),
    ).toBeUndefined();
  });

  it.each([
    "missing-completion",
    "cross-instance",
    "duplicate-completion",
    "second-turn",
    "changed-account",
  ] as const)("rejects %s evidence with the same shared Gateway matcher", (fault) => {
    const { requestLog, threadIds } = seedAuthEvidenceThreads();
    const threadId = threadIds[0]!;
    const run = runAuthEvidence(requestLog, [
      fixtureLogin(FIXTURE_ACCOUNT_A),
      { id: 2, method: "thread/resume", params: { threadId } },
      { id: 3, method: "turn/start", params: { threadId } },
    ]);
    const params = { afterIndex: run.afterIndex, threadId, accountId: FIXTURE_ACCOUNT_A };
    const valid = findCodexFixtureTurnAccountEvidence(run.entries, params);
    expect(valid).toMatchObject({
      account: { type: "chatgptAuthTokens", accountId: "qa-codex-configured-account" },
    });
    const entries = structuredClone(run.entries);
    const startIndex = entries.findIndex(
      (row, index) =>
        index >= run.afterIndex && row.fixtureAuthOperation?.operation === "turn_started",
    );
    const completionIndex = entries.findIndex(
      (row, index) =>
        index >= run.afterIndex && row.fixtureAuthOperation?.operation === "turn_completed",
    );
    expect(startIndex).toBeGreaterThanOrEqual(run.afterIndex);
    expect(completionIndex).toBeGreaterThan(startIndex);
    const started = entries[startIndex]!.fixtureAuthOperation!;
    const completed = entries[completionIndex]!.fixtureAuthOperation!;
    if (fault === "missing-completion") {
      entries.splice(completionIndex, 1);
    } else if (fault === "cross-instance") {
      const otherInstance = authOperations(entries.slice(0, run.afterIndex))[0]!.instanceId;
      expect(otherInstance).not.toBe(valid!.instanceId);
      completed.instanceId = otherInstance;
    } else if (fault === "duplicate-completion") {
      entries.push(structuredClone(entries[completionIndex]!));
    } else if (fault === "second-turn") {
      entries.push(
        {
          fixtureAuthOperation: {
            ...started,
            sequence: completed.sequence + 1,
            turnId: "second-native-turn",
          },
        },
        {
          fixtureAuthOperation: {
            ...completed,
            sequence: completed.sequence + 2,
            turnId: "second-native-turn",
          },
        },
      );
    } else {
      completed.account = { type: "chatgptAuthTokens", accountId: "qa-codex-account" };
    }
    expect(findCodexFixtureTurnAccountEvidence(entries, params)).toBeUndefined();
    expect(findCodexFixtureTurnAccountEvidence(run.entries, params)).toEqual(valid);
  });
});
