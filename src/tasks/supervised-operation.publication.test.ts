import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { evaluateSupervisedChecks } from "./supervised-operation.ci.js";
import { runSupervisedPublication } from "./supervised-operation.publication.js";
import {
  assertSupervisedOperationCurrent,
  claimSupervisedOperation,
  enqueueSupervisedOperation,
  getSupervisedOperation,
  markSupervisedOperationReconciling,
  releaseSupervisedOperationForReconciliation,
  reserveSupervisedOperationDispatch,
  resolveSupervisedOperationReconciliation,
} from "./supervised-operation.store.js";
import {
  cancelSupervisedTask,
  claimSupervisedTask,
  createSupervisedTask,
  heartbeatTaskSupervisor,
} from "./supervised-task.store.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";

const transport = vi.hoisted(() => ({
  command: vi.fn(),
  require: vi.fn(),
  identity: vi.fn(),
  artifact: vi.fn(),
}));
vi.mock("../gateway/github-publication-availability.js", () => ({
  prepareCurrentGitHubPublicationIdentity: transport.identity,
  matchesCurrentGitHubPublicationIdentity: () => true,
}));
vi.mock("../gateway/github-publication-git-transport.js", async (original) => ({
  ...(await original<typeof import("../gateway/github-publication-git-transport.js")>()),
  runPublicationCommand: transport.command,
  requirePublicationCommand: transport.require,
}));
vi.mock("./supervised-publication-artifact.js", async (original) => ({
  ...(await original<typeof import("./supervised-publication-artifact.js")>()),
  prepareSupervisedPublicationArtifact: transport.artifact,
}));
const dirs = createTempDirTracker();
const head = "a".repeat(40);
const base = "b".repeat(40);
let remote: string | undefined;
let exists: boolean;
let failAfterPush: boolean;
let failAfterCreate: boolean;
let pushCount: number;
let createCount: number;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  remote = undefined;
  exists = false;
  failAfterPush = false;
  failAfterCreate = false;
  pushCount = 0;
  createCount = 0;
  transport.identity.mockReset().mockResolvedValue({
    source: "system-detected",
    account: { accountId: 1, login: "author" },
    env: {},
  });
  transport.artifact.mockReset().mockImplementation(async ({ execution }) => ({
    artifactId: execution.executionId,
    sourceHash: "c".repeat(64),
    headCommit: head,
    baseCommit: base,
    tree: "d".repeat(40),
    preparedAt: 1000,
    pushReservedAt: null,
    createReservedAt: null,
    remoteHead: null,
    pullRequestUrl: null,
  }));
});
afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

function fixture() {
  const root = dirs.make("supervised-publication-");
  mkdirSync(`${root}/workspace`);
  const options = { path: `${root}/state.sqlite` };
  const contract = encodeSupervisedWorkflowContract({
    version: 1,
    workspace: `${root}/workspace`,
    profiles: [
      {
        kind: "publication",
        id: "publish",
        repository: "upstream/repo",
        pushRepository: "author/repo",
        branch: "work",
        baseBranch: "main",
        baseCommit: base,
        title: "Task update",
        body: "Evidence",
        timeoutMs: 60_000,
        publisher: {
          agentId: "poc",
          accountId: 1,
          login: "author",
          source: "system-detected",
          signingKey: "A".repeat(40),
          gitAuthor: { name: "Accepted Author", email: "accepted@example.test" },
        },
      },
    ],
    acceptance: [{ kind: "receipts", criterionId: "published", profiles: ["publish"] }],
  }).contract;
  const profile = contract.profiles[0]!;
  if (profile.kind !== "publication") {
    throw new Error("Fixture profile mismatch");
  }
  heartbeatTaskSupervisor("supervisor", 1000, 10_000, options);
  const task = createSupervisedTask(
    {
      flowId: randomUUID(),
      agentId: "poc",
      runtime: "codex",
      model: "openai/test",
      prompt: "Publish accepted work",
      goal: {
        objective: "Publish",
        success: [{ id: "published", description: "Verified publication" }],
        partial: [],
      },
      policy: { deadlineAt: 100_000, maxAttempts: 10, attemptTimeoutMs: 10_000 },
      workflow: contract,
    },
    "supervisor",
    1000,
    options,
  );
  const attempt = claimSupervisedTask(task.flowId, "supervisor", 1000, options)!;
  const operation = enqueueSupervisedOperation(
    attempt,
    { key: "publish", kind: "publication", profile: "publish" },
    1000,
    options,
  );
  const marker = `<!-- openclaw-supervised-operation:${operation.operationId}:${head} -->`;
  transport.require.mockReset().mockImplementation(async (args: string[]) => {
    if (args.includes("ls-remote")) {
      return remote ? `${remote}\trefs/heads/work` : "";
    }
    if (args.some((arg) => arg.endsWith("/pulls"))) {
      return JSON.stringify(
        exists
          ? [
              {
                number: 4,
                html_url: "https://github.com/upstream/repo/pull/4",
                state: "open",
                body: marker,
                user: { id: 1 },
                head: { sha: head, ref: "work", repo: { full_name: "author/repo" } },
                base: { ref: "main", repo: { full_name: "upstream/repo" } },
              },
            ]
          : [],
      );
    }
    if (args.some((arg) => arg.includes("/commits/"))) {
      return JSON.stringify({ sha: head, commit: { verification: { verified: true } } });
    }
    throw new Error("Unexpected transport call");
  });
  transport.command.mockReset().mockImplementation(async (args: string[]) => {
    if (args.includes("push")) {
      remote = head;
      pushCount += 1;
      if (failAfterPush) {
        failAfterPush = false;
        throw new Error("Lost push response");
      }
    } else if (args.includes("POST")) {
      exists = true;
      createCount += 1;
      if (failAfterCreate) {
        failAfterCreate = false;
        throw new Error("Lost creation response");
      }
    } else {
      throw new Error("Unexpected effect");
    }
    return { code: 0, stdout: Buffer.from("{}") };
  });
  const claim = () => {
    const execution = claimSupervisedOperation(
      operation.operationId,
      randomUUID(),
      Date.now(),
      options,
    )!;
    return {
      contract,
      profile,
      execution,
      options,
      assertCurrent: () => assertSupervisedOperationCurrent(execution, Date.now(), options),
      reserveDispatch: () => reserveSupervisedOperationDispatch(execution, Date.now(), options),
    };
  };
  return { task, operation, options, claim };
}

it.each(["push", "create"] as const)(
  "recovers a lost %s response without repeating the observed external effect",
  async (fault) => {
    const f = fixture();
    failAfterPush = fault === "push";
    failAfterCreate = fault === "create";
    const first = f.claim();
    await expect(runSupervisedPublication(first)).rejects.toThrow(/Lost/);
    releaseSupervisedOperationForReconciliation(first.execution, 1000, f.options);
    const reconciling = markSupervisedOperationReconciling(first.execution, 1000, f.options);
    resolveSupervisedOperationReconciliation(
      reconciling,
      {
        retryAt: 1001,
        evidence: "Fixture runner has exited; exact external identity will be read before action",
      },
      1000,
      f.options,
    );
    vi.setSystemTime(1001);
    const result = await runSupervisedPublication(f.claim());
    expect(result.status).toBe("succeeded");
    expect(pushCount).toBe(1);
    expect(createCount).toBe(1);
    expect(transport.artifact).toHaveBeenCalledTimes(1);
    expect(getSupervisedOperation(f.operation.operationId, f.options)?.publication).toMatchObject({
      headCommit: head,
      remoteHead: head,
      pullRequestUrl: "https://github.com/upstream/repo/pull/4",
    });
  },
);

it("refuses an unrelated remote branch without overwriting or creating a PR", async () => {
  const f = fixture();
  remote = "f".repeat(40);
  await expect(runSupervisedPublication(f.claim())).rejects.toThrow(/advanced independently/);
  expect(pushCount).toBe(0);
  expect(createCount).toBe(0);
});

it("rejects an account switch before preparing or publishing", async () => {
  const f = fixture();
  transport.identity.mockResolvedValue({
    source: "system-detected",
    account: { accountId: 2, login: "different" },
    env: {},
  });
  await expect(runSupervisedPublication(f.claim())).rejects.toThrow(/account changed/);
  expect(transport.artifact).not.toHaveBeenCalled();
  expect(pushCount).toBe(0);
});

it("retains a late observed push after cancellation without granting PR creation", async () => {
  const f = fixture();
  transport.command.mockImplementation(async () => {
    remote = head;
    pushCount += 1;
    cancelSupervisedTask(f.task.flowId, Date.now(), f.options);
    return { code: 0, stdout: Buffer.from("") };
  });
  await expect(runSupervisedPublication(f.claim())).rejects.toThrow(/no longer/);
  expect(pushCount).toBe(1);
  expect(createCount).toBe(0);
});

it("binds CI to the exact commit and accepted App, rejects skipped checks, and observes reruns", () => {
  const required = [{ name: "build", appId: 10 }];
  const run = {
    id: 1,
    name: "build",
    app: { id: 10 },
    head_sha: head,
    status: "completed",
    conclusion: "success",
  };
  expect(evaluateSupervisedChecks([{ ...run, head_sha: base }], head, required)).toBe("pending");
  expect(evaluateSupervisedChecks([{ ...run, app: { id: 11 } }], head, required)).toBe("pending");
  expect(evaluateSupervisedChecks([{ ...run, conclusion: "skipped" }], head, required)).toBe(
    "failed",
  );
  expect(
    evaluateSupervisedChecks(
      [run, { ...run, id: 2, status: "in_progress", conclusion: null }],
      head,
      required,
    ),
  ).toBe("pending");
  expect(evaluateSupervisedChecks([run], head, required)).toBe("succeeded");
});
