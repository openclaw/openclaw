// Load the mock-bearing owner before production imports (Vitest module initialization).
// oxfmt-ignore
import {
  createFixture,
  agentResult,
  readObservation,
  accessor,
  replacementSession,
  readRecipeTarget,
  localCommands,
  publicationCommands,
} from "./service.pr-automation.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { resolveAdmittedRunActiveAssertion } from "../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import * as publicationTransport from "../gateway/github-publication-git-transport.js";
import { createGitHubPublicationCoordinator } from "../gateway/github-publication.js";
import {
  SESSION,
  SESSION_ID,
  stateDir,
} from "../gateway/server-methods/requester-cron-authority.test-support.js";
import { sessionMutationHandlers } from "../gateway/server-methods/sessions-mutations.js";
import { createWorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import type { BufferedCommandResult } from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runEmbeddedAgentMock } from "./isolated-agent/run.test-harness.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { cronStoreKey } from "./store/key.js";
import { maintainCronRunHistory } from "./store/run-history.js";
const patchSession = expectDefined(sessionMutationHandlers["sessions.patch"], "sessions.patch");

it("native read-only edit retains the linked-account refusal for a source-less scheduled bound PR", async () => {
  await using fixture = await createFixture("autoFix", false);
  fixture.creator.context.githubPublicationService = createGitHubPublicationCoordinator({
    placements: createWorkerSessionPlacementStore(),
    getCommittedRuntimeConfig: fixture.creator.context.getRuntimeConfig,
  });
  // Control: bypass only the new observer; invoke the existing native tool from the actual due model turn.
  await fixture.execution.update(fixture.selected.id, {
    trigger: { script: "return { fire: true };" },
    enabled: true,
  });
  let refusal: unknown;
  runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
    const admitted = await expectDefined(params.preparedRunAdmission, "scheduled admission").admit(
      "gateway",
      params.runId,
    );
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    bindGatewayContextResolver(admitted, () => fixture.creator.context);
    const caller = expectDefined(
      createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: admitted,
        agentId: "main",
        sessionKey: SESSION,
      }),
      "native caller",
    );
    try {
      await withGatewayToolCallerIdentity(caller, () =>
        createGitHubPublishTool().execute("read-only-control", { action: "edit" }),
      );
    } catch (error) {
      refusal = error;
    }
    return agentResult();
  });
  const event = await fixture.tick();
  expect(event, JSON.stringify(event)).toMatchObject({ status: "ok" });
  expect(event?.error, JSON.stringify(event)).toBeUndefined();
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal instanceof Error ? refusal.message : refusal).toContain(
    "verified linked GitHub account",
  );
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  expect(fixture.reads).not.toContain("graphql");
});

it("retains a direct authenticated Control UI source before reload and executes the due autoFix", async () => {
  await using fixture = await createFixture("autoFix", true, false, true);
  expect(fixture.selected.operatorSource?.source).toMatchObject({
    kind: "gateway",
    snapshot: { sourceIngress: "control-ui" },
  });
  runEmbeddedAgentMock.mockImplementation(async (params) => {
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    return agentResult();
  });
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  const event = await fixture.tick();
  expect(event, JSON.stringify(event)).toMatchObject({ status: "ok" });
  expect(fixture.reads).toContain("graphql");
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  fixture.finding.updatedAt = "2026-11-10T14:00:00Z";
  fixture.revokeDevice();
  expect(await fixture.tick()).toMatchObject({ status: "error" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  expect(fixture.execution.getJob(fixture.selected.id)?.enabled).toBe(false);
});

it.each(["closed", "merged"])(
  "removes only the exact current job for a %s PR, retrying a no-op cleanup",
  async (terminal) => {
    await using fixture = await createFixture("autoFix", true, false, true);
    fixture.pr.state = "closed";
    fixture.pr.merged = terminal === "merged";
    await fixture.execution.update(fixture.selected.id, { enabled: true });
    const remove = fixture.execution.remove.bind(fixture.execution);
    const cleanup = vi
      .spyOn(fixture.execution, "remove")
      .mockResolvedValueOnce({ ok: true, removed: false });
    onTestFinished(() => cleanup.mockRestore());
    expect(await fixture.tick()).toMatchObject({ status: "error" });
    expect(fixture.execution.getJob(fixture.selected.id)?.enabled).toBe(true);
    cleanup.mockImplementation(remove);
    await fixture.tick();
    expect(fixture.execution.getJob(fixture.selected.id)).toBeUndefined();
    expect(fixture.execution.getJob(fixture.other.id)).toMatchObject({ enabled: false });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  },
);

it("cancellation during the native read starts no model and commits no observation", async () => {
  await using fixture = await createFixture("autoFix");
  const read = expectDefined(fixture.nativeRead.getMockImplementation(), "native transport");
  fixture.nativeRead.mockImplementation(async (...args) => {
    const result = await read(...args);
    if (args[0].includes("graphql")) {
      await fixture.execution.update(fixture.selected.id, { enabled: false });
    }
    return result;
  });
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  expect(await fixture.tick()).toMatchObject({ status: "error" });
  expect(fixture.reads).toContain("graphql");
  expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toBeUndefined();
  expect(fixture.execution.getJob(fixture.selected.id)?.enabled).toBe(false);
});

it("keeps autoMerge on its independently authorized model route", async () => {
  await using fixture = await createFixture("autoMerge");
  runEmbeddedAgentMock.mockImplementation(async (params) => {
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    expect(params.prompt).toContain("Only when every required gate is satisfied");
    return agentResult();
  });
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  expect(fixture.reads).not.toContain("graphql");
  expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toBeUndefined();
});

it("transports direct UI autoFix for only the selected PR across session replacement and disables future effects", async () => {
  await using fixture = await createFixture("autoFix", true, false, true);
  const effectTarget = (number: number) => ({ owner: "fixture-org", repo: "fixture-repo", number });
  const effect41 = effectTarget(41);
  const finalEffect =
    vi.fn<(target: { owner: string; repo: string; number: number }, sessionId: string) => void>();
  runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
    const admitted = await expectDefined(params.preparedRunAdmission, "scheduled admission").admit(
      "gateway",
      params.runId,
    );
    expectDefined(resolveAdmittedRunActiveAssertion(admitted), "active admission assertion")();
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    const target = readRecipeTarget(params.prompt);
    finalEffect(
      { owner: target.owner, repo: target.repo, number: target.number },
      params.sessionId,
    );
    return agentResult();
  });
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  expect(await fixture.tick()).toMatchObject({ jobId: fixture.selected.id, status: "ok" });
  expect(finalEffect.mock.calls).toEqual([[effect41, SESSION_ID]]);
  await fixture.seed(replacementSession);
  fixture.finding.body = "New feedback after conversation replacement";
  fixture.finding.updatedAt = "2026-11-10T12:00:00Z";
  const replacementEvent = await fixture.tick();
  expect(replacementEvent, JSON.stringify(replacementEvent)).toMatchObject({
    jobId: fixture.selected.id,
    status: "ok",
  });
  expect(finalEffect.mock.calls[1]).toEqual([effect41, replacementSession]);
  await fixture.execution.update(fixture.selected.id, { enabled: false });
  await fixture.execution.update(fixture.other.id, { enabled: true });
  expect(await fixture.tick()).toMatchObject({
    jobId: fixture.other.id,
    status: "error",
    error: expect.stringContaining("not this session"),
  });
  expect(finalEffect.mock.calls).toEqual([
    [effect41, SESSION_ID],
    [effect41, replacementSession],
  ]);
  expect(fixture.execution.getJob(fixture.selected.id)?.enabled).toBe(false);
  expect((await fixture.add({ ...fixture.target, sessionId: replacementSession })).id).toBe(
    fixture.selected.id,
  );
});

it("revokes an embedded continuation when its source conversation is replaced", async () => {
  await using fixture = await createFixture("autoFix");
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  await fixture.seed(replacementSession);
  expect(await fixture.tick()).toMatchObject({
    status: "error",
    error: expect.stringContaining("definition or conversation changed"),
  });
  expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  expect(fixture.reads).not.toContain("graphql");
  expect(fixture.execution.getJob(fixture.selected.id)?.enabled).toBe(false);
});

it.each([false, true])(
  "existing archive API checks the scheduled recipe's exact identity (replaced=%s)",
  async (replaced) => {
    const fixture = await createFixture("autoArchive", false);
    const respond = vi.fn();
    const releaseCore = createDeferredCore();
    const releaseArchiveEffects = createDeferredCore();
    const cron = fixture.creator.context.cron;
    const updateWithPrecondition = cron.updateWithPrecondition.bind(cron);
    const archiveUpdate = !replaced
      ? vi.spyOn(cron, "updateWithPrecondition").mockImplementation(async (...args) => {
          const result = await updateWithPrecondition(...args);
          // Hold the archive handler after the real worker commit and cancellation.
          await releaseArchiveEffects.promise;
          return result;
        })
      : undefined;
    let archiveRequest: Promise<void> | undefined;
    runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      const target = readRecipeTarget(params.prompt);
      const patch = {
        key: target.sessionKey,
        expectedSessionId: expectDefined(target.sessionId, "archive incarnation"),
        archived: true,
      };
      archiveRequest = Promise.resolve(
        patchSession({ ...fixture.rpc("sessions.patch", patch), respond }),
      );
      await archiveRequest;
      if (!replaced) {
        await releaseCore.promise;
      }
      return agentResult();
    });
    try {
      if (replaced) {
        await fixture.seed(replacementSession);
      }
      await fixture.execution.update(fixture.selected.id, { enabled: true });
      const event = await fixture.tick(false);
      releaseArchiveEffects.resolve();
      // Archive commits before cancellation settles the occurrence and RPC.
      expect(event).toMatchObject({
        jobId: fixture.selected.id,
        ...(replaced
          ? { status: "ok" }
          : { status: "error", error: "Cron job disabled by operator." }),
      });
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      await expectDefined(archiveRequest, "archive request");
      const stored = accessor.loadSessionEntry(fixture.sessionRef);
      if (replaced) {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ details: { reason: "session-changed" } }),
        );
        expect(stored).toMatchObject({ sessionId: replacementSession });
        expect(stored?.archivedAt).toBeUndefined();
      } else {
        expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
        expect(stored).toMatchObject({ sessionId: SESSION_ID, archivedAt: expect.any(Number) });
        const stopped = vi.fn();
        const teardown = fixture.stop().then(stopped);
        // Keep the core held across a worker round-trip before checking teardown.
        expect((await fixture.creator.read()).every((job) => !job.enabled)).toBe(true);
        expect(stopped).not.toHaveBeenCalled();
        releaseCore.resolve();
        await teardown;
        expect(stopped).toHaveBeenCalledOnce();
      }
    } finally {
      releaseArchiveEffects.resolve();
      releaseCore.resolve();
      await fixture.stop();
      archiveUpdate?.mockRestore();
    }
  },
);
it.each([
  {
    mode: "addressed-unresolved",
    behavior:
      "keeps publication-backed addressed unresolved feedback quiet until its revision changes",
  },
  {
    mode: "reopened-thread",
    behavior:
      "does not reuse an earlier qualified publication and judgment when its unchanged thread reopens",
  },
  {
    mode: "own-publication",
    behavior: "observes a bindingless own publication and refuses a changed shared publisher",
  },
  {
    mode: "pending-publication",
    behavior:
      "reconciles the same pending publication request through the Cron observer without resubmission",
  },
  {
    mode: "nonthread-addressed",
    behavior: "accepts exact nonthread addressed evidence only with its accepted publication",
  },
])("$behavior", async ({ mode }) => {
  await using fixture = await createFixture("autoFix");
  if (mode === "nonthread-addressed") {
    fixture.graph.reviewThreads = fixture.connection([]);
    fixture.graph.comments = fixture.connection([fixture.finding]);
  }
  const git = async (...args: string[]) => {
    const result = await localCommands.runCommandBuffered(["git", ...args], {
      cwd: fixture.workspaceDir,
      timeoutMs: 10_000,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.toString());
    }
    return result.stdout.toString().trim();
  };
  const sourceHead = await git("rev-parse", "HEAD");
  fixture.pr.head.sha = sourceHead;
  fixture.pr.base.sha = sourceHead;
  fixture.graph.headRefOid = sourceHead;
  expectDefined(fixture.graph.commits.nodes[0], "head commit").commit.oid = sourceHead;
  expectDefined(fixture.graph.commits.nodes[0], "head commit").commit.statusCheckRollup = {
    state: "SUCCESS",
    contexts: fixture.connection([
      {
        __typename: "CheckRun",
        id: "verified-check",
        name: "unit",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        completedAt: "2026-11-10T10:00:00Z",
      },
    ]),
  };
  const loaded = expectDefined(accessor.loadSessionEntryReadOnly(fixture.sessionRef), "session");
  const worktree = expectDefined(loaded.worktree, "worktree");
  const binding = expectDefined(worktree.githubPullRequest, "binding");
  await accessor.upsertSessionEntryCore(fixture.sessionRef, {
    ...loaded,
    worktree: {
      ...worktree,
      githubPullRequest: {
        ...binding,
        preparedHeadCommit: sourceHead,
        base: { ...binding.base, commit: sourceHead },
        head: { ...binding.head, commit: sourceHead },
      },
    },
  });
  const read = fixture.nativeRead.getMockImplementation()!;
  const json = (value: unknown): BufferedCommandResult => ({
    code: 0,
    stdout: Buffer.from(JSON.stringify(value)),
    stderr: Buffer.alloc(0),
    signal: null,
    killed: false,
    termination: "exit",
  });
  fixture.nativeRead.mockImplementation(async (argv, options) => {
    if (argv[0] === "git") {
      options?.beforeRun?.();
      if (argv.includes("push")) {
        const refspec = expectDefined(
          argv.find((arg) => /^[a-f0-9]+:refs\/heads\//u.test(arg)),
          "exact push",
        );
        fixture.pr.head.sha = expectDefined(refspec.split(":")[0], "pushed head");
        fixture.graph.headRefOid = fixture.pr.head.sha;
        expectDefined(fixture.graph.commits.nodes[0], "head commit").commit.oid =
          fixture.pr.head.sha;
        return json(null);
      }
      if (argv.includes("fetch")) {
        return json(null);
      }
      if (argv.includes("ls-remote")) {
        return { ...json(null), stdout: Buffer.from(`${fixture.pr.head.sha}\t${argv.at(-1)}\n`) };
      }
      // All remaining effects are local Git in this private fixture; never run gh.
      const result = await localCommands.runCommandBuffered(argv, {
        cwd: fixture.workspaceDir,
        env: options?.env,
        input: typeof options?.input === "function" ? options.input() : options?.input,
        timeoutMs: 10_000,
      });
      return result;
    }
    const endpoint = argv.find((arg) => arg.startsWith("repos/"));
    if (endpoint?.endsWith("/pulls/41") && argv.some((arg) => arg.includes("headRepositoryId:"))) {
      return json({
        url: fixture.pr.html_url,
        userId: fixture.pr.user.id,
        state: fixture.pr.state,
        body: "",
        headSha: fixture.pr.head.sha,
        headRef: fixture.pr.head.ref,
        baseRef: fixture.pr.base.ref,
        headRepository: fixture.pr.head.repo.full_name,
        headRepositoryId: fixture.pr.head.repo.id,
        baseRepository: fixture.pr.base.repo.full_name,
        baseRepositoryId: fixture.pr.base.repo.id,
      });
    }
    if (endpoint?.includes("/branches/")) {
      return json({
        name: fixture.pr.head.ref,
        commit: { sha: fixture.pr.head.sha },
        protected: false,
      });
    }
    if (endpoint?.includes("/git/ref/heads/")) {
      return json({ ref: "refs/heads/main", sha: sourceHead });
    }
    if (endpoint?.includes("/git/commits/")) {
      const sha = endpoint.split("/").at(-1)!;
      const [tree, parent, ...message] = (
        await git("show", "-s", "--format=%T%n%P%n%B", sha)
      ).split("\n");
      return json({
        sha,
        tree: { sha: tree },
        parents: [{ sha: parent }],
        message: message.join("\n"),
      });
    }
    if (endpoint?.includes("/commits/")) {
      return json(["README.md"]);
    }
    return read(argv, options);
  });
  publicationCommands.run.mockImplementation(async (argv, options) => {
    if (
      argv[0] === "gh" ||
      (argv[0] === "git" && argv.some((arg) => ["fetch", "push", "ls-remote"].includes(arg)))
    ) {
      return await publicationTransport.runPublicationCommand(argv, {
        cwd: options?.cwd,
        env: options?.env,
        timeoutMs: options?.timeoutMs,
        noOutputTimeoutMs: options?.noOutputTimeoutMs,
        maxOutputBytes:
          typeof options?.maxOutputBytes === "number" ? options.maxOutputBytes : undefined,
        input: options?.input === undefined ? undefined : Buffer.from(options.input),
      });
    }
    return localCommands.runCommandBuffered(argv, options);
  });
  const placements = createWorkerSessionPlacementStore();
  fixture.creator.context.githubPublicationService = createGitHubPublicationCoordinator({
    placements,
    getCommittedRuntimeConfig: fixture.creator.context.getRuntimeConfig,
  });
  const pendingPlacement =
    mode === "pending-publication"
      ? await placements.startDispatch({
          agentId: "main",
          sessionKey: SESSION,
          sessionId: SESSION_ID,
        })
      : undefined;
  let publication: Record<string, unknown> | undefined;
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async ({ automation, publication: publisher }) => {
      if (publication) {
        return agentResult();
      }
      const observation = readObservation(params.prompt);
      await fs.writeFile(
        path.join(fixture.workspaceDir, "README.md"),
        "repair unchecked failure\n",
      );
      // Native SQLite lease owners use wall time; do not compare their expiries
      // against this scheduler's synthetic five-minute jumps.
      publication = asRecord(
        (await fixture.withWallClock(() => publisher.execute("repair-publication", {}))).details,
      );
      if (mode === "pending-publication") {
        expect(publication.status).toBe("requested");
        await automation.execute("queued", {
          action: "record_result",
          outcome: "done",
          summary: "Publication accepted; wait for its original request",
        });
        return agentResult();
      }
      if (publication.status !== "published") {
        throw new Error(JSON.stringify(publication));
      }
      fixture.thread.isResolved = mode !== "addressed-unresolved";
      const scratch = await automation.execute("read", { action: "scratch_get" });
      await automation.execute("judge", {
        action: "scratch_set",
        expectedRevision: asRecord(scratch.details).currentRevision,
        content: JSON.stringify({
          prAutoFix: {
            url: fixture.pr.html_url,
            head: publication.headCommit,
            publicationRequestId: publication.requestId,
            attempt: observation.fingerprint,
            findings: observation.findings.map((finding) => ({
              id: finding.id,
              revision: finding.revision,
              body: finding.body,
              status: "addressed",
              reason: "Repaired unchecked failure in the accepted change",
              quote: fixture.finding.body,
              path: "README.md",
            })),
          },
        }),
      });
      await automation.execute("done", {
        action: "record_result",
        outcome: "done",
        summary: "Published and verified repair",
      });
      return agentResult();
    }),
  );
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  if (pendingPlacement) {
    const requestId = expectDefined(publication, "accepted publication").requestId;
    expect(publication).toMatchObject({ status: "requested", requestId: expect.any(String) });
    const failed = await placements.fail({
      sessionId: SESSION_ID,
      expectedGeneration: pendingPlacement.generation,
      recoveryError: "Fixture dispatch cancelled before provisioning",
    });
    await placements.transition({
      sessionId: SESSION_ID,
      from: "failed",
      to: "local",
      expectedGeneration: failed.generation,
    });
    // A native active turn defers recovery. Release that exact claim before retrying.
    const held = await fixture.withWallClock(() =>
      placements.claimTurn({
        agentId: "main",
        sessionKey: SESSION,
        sessionId: SESSION_ID,
        owner: { kind: "local" },
        claimId: "pending-observer",
        runId: "pending-observer",
      }),
    );
    expect(await fixture.withWallClock(() => fixture.tick())).toBeUndefined();
    expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toMatchObject({
      pendingRequestId: requestId,
    });
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    await fixture.withWallClock(() => placements.releaseTurn(held));
    // Recovery changes the remote head during this observation. The next bounded
    // observation retries the read, not publication, and keeps the original id.
    await fixture.withWallClock(() => fixture.tick());
    await fixture.withWallClock(() => fixture.tick());
    const recovered = fixture.execution.getJob(fixture.selected.id)?.state.triggerState;
    expect(recovered).toMatchObject({
      publication: { status: "published", requestId, headCommit: fixture.pr.head.sha },
    });
    expect(asRecord(recovered).pendingRequestId).toBeNull();
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(
      fixture.nativeRead.mock.calls.filter(([argv]) => argv[0] === "git" && argv.includes("push")),
    ).toHaveLength(1);
    return;
  }
  if (mode === "own-publication") {
    const current = expectDefined(
      accessor.loadSessionEntryReadOnly(fixture.sessionRef),
      "published session",
    );
    await accessor.upsertSessionEntryCore(fixture.sessionRef, {
      ...current,
      worktree: {
        ...expectDefined(current.worktree, "published worktree"),
        githubPullRequest: undefined,
      },
    });
    expect(
      accessor.loadSessionEntryReadOnly(fixture.sessionRef)?.worktree?.githubPullRequest,
    ).toBeUndefined();
  }
  expect(publication).toMatchObject({
    status: "published",
    url: fixture.pr.html_url,
    headCommit: fixture.pr.head.sha,
  });
  expect(await fixture.tick()).toBeUndefined();
  const state = asRecord(fixture.execution.getJob(fixture.selected.id)?.state.triggerState);
  expect(state.dispositions).toEqual([
    expect.objectContaining({ status: "addressed", requestId: publication?.requestId }),
  ]);
  fixture.execution.stop();
  await fixture.execution.waitForIdle();
  await fixture.execution.start();
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  if (mode === "addressed-unresolved") {
    expect(fixture.thread.isResolved).toBe(false);
    expect(fixture.pr.head.sha).toBe(publication?.headCommit);
    fixture.finding.body = "Edited review: the repaired path still needs a timeout";
    fixture.finding.updatedAt = "2026-11-10T16:00:00Z";
    expect(await fixture.tick()).toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(
      asRecord(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).dispositions,
    ).toEqual(state.dispositions);
    return;
  }
  if (mode === "own-publication") {
    // An otherwise eligible App bot's own producer output remains suppressed.
    fixture.pr.user.type = "Bot";
    fixture.graph.comments = fixture.connection([
      {
        ...fixture.finding,
        id: "producer-comment",
        authorAssociation: "NONE",
        author: { login: "publisher[bot]", __typename: "Bot", databaseId: 42 },
      },
    ]);
    expectDefined(fixture.graph.commits.nodes[0], "head commit").commit.statusCheckRollup = {
      state: "SUCCESS",
      contexts: fixture.connection([
        {
          __typename: "CheckRun",
          id: "producer-app-check",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          checkSuite: {
            app: { slug: "publisher" },
            repository: { nameWithOwner: "fixture-org/fixture-repo" },
          },
        },
      ]),
    };
    expect(await fixture.tick()).toBeUndefined();
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    const before = fixture.execution.getJob(fixture.selected.id)?.state.triggerState;
    fixture.identity.mockResolvedValue({
      source: "system-detected",
      host: "github.com",
      account: { accountId: 77, login: "changed-publisher", avatarUrl: null },
      env: {},
    });
    expect(await fixture.tick()).toMatchObject({
      status: "error",
      error: expect.stringContaining("identity changed"),
    });
    expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toEqual(before);
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    return;
  }
  if (mode === "nonthread-addressed") {
    fixture.finding.updatedAt = "2026-11-10T15:00:00Z";
    expect(await fixture.tick()).toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(
      asRecord(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).dispositions,
    ).toEqual(state.dispositions);
    return;
  }
  fixture.thread.isResolved = false;
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
  const reopened = asRecord(fixture.execution.getJob(fixture.selected.id)?.state.triggerState);
  expect(reopened.dispositions).toEqual([]);
  expect(reopened.quietFindings).toEqual([]);
  expect(reopened.disposition).toMatchObject({ status: "blocked" });
  // This reopened dispatch has the same fingerprint, but is a new occurrence.
  // Observing the old turn does not establish this turn's missing outcome.
  fixture.execution.stop();
  await fixture.execution.waitForIdle();
  fixture.advanceTime(8 * 24 * 60 * 60_000);
  const context = captureOpenClawStateWorkerContext();
  await maintainCronRunHistory(context, context.admission.assertCurrent);
  expect(
    readCronRunHistoryPageForTests({
      storeKey: cronStoreKey(path.join(stateDir, "cron", "jobs.json")),
      jobId: fixture.selected.id,
      runId: `cron:${fixture.selected.id}:${String(asRecord(reopened.attempt).atMs)}`,
    }).entries,
  ).toEqual([]);
  await fixture.execution.start();
  for (let tick = 0; tick < 12; tick++) {
    expect(await fixture.tick()).toBeUndefined();
  }
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
  expect(fixture.execution.getJob(fixture.selected.id)?.state.triggerState).toMatchObject({
    dispositions: [],
    blocked: expect.stringContaining("manual review"),
  });
});
