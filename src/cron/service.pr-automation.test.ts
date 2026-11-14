// Load the mock-bearing owner before production imports (Vitest module initialization).
// oxfmt-ignore
import {
  createFixture,
  agentResult,
  readObservation,
  recordJudgment,
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
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { commandResult } from "../agents/github-identity.test-support.js";
import { git as fixtureGit } from "../agents/worktrees/git-fixture.test-support.js";
import * as publicationTransport from "../gateway/github-publication-git-transport.js";
import { readPublicationCommit } from "../gateway/github-publication-git.test-support.js";
import { readGitHubPublicationRequestAsync } from "../gateway/github-publication-store-async.js";
import { createGitHubPublicationCoordinator } from "../gateway/github-publication.js";
import { invalidateOperatorRolePolicy } from "../gateway/operator-role-policy.js";
import {
  SESSION,
  SESSION_ID,
} from "../gateway/server-methods/requester-cron-authority.test-support.js";
import { sessionMutationHandlers } from "../gateway/server-methods/sessions-mutations.js";
import { performGatewaySessionReset } from "../gateway/session-reset-service.js";
import { createWorkerSessionPlacementStore } from "../gateway/worker-environments/placement-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readGitHubPublicationSessionLifecycleInWorker } from "../state/github-publication-session-lifecycles.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { runEmbeddedAgentMock } from "./isolated-agent/run.test-harness.js";
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
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async ({ publication }) => {
      await expect(publication.execute("read-only-control", { action: "edit" })).rejects.toThrow(
        "verified linked GitHub account",
      );
      return agentResult();
    }),
  );
  const event = await fixture.tick();
  expect(event, JSON.stringify(event)).toMatchObject({ status: "ok", error: undefined });
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  expect(fixture.reads).not.toContain("graphql");
});

it.each([false, true])(
  "direct UI enable retains authority after reload (source-less legacy=%s)",
  async (legacy) => {
    await using fixture = await createFixture("autoFix", true, legacy, true);
    const original = fixture.selected;
    if (legacy) {
      expect(fixture.execution.getJob(original.id)?.operatorSource).toBeUndefined();
      await fixture.updateFromUi(false);
      expect(
        (await fixture.creator.read()).find((job) => job.id === original.id)?.operatorSource,
      ).toBeUndefined();
    }
    await fixture.updateFromUi(true);
    const persisted = (await fixture.creator.read()).find((job) => job.id === original.id);
    expect(persisted).toMatchObject({ id: original.id, payload: original.payload });
    expect(persisted?.operatorSource?.source).toMatchObject({
      kind: "gateway",
      snapshot: { sourceIngress: "control-ui" },
    });
    runEmbeddedAgentMock.mockImplementation((params) =>
      fixture.modelTools(params, async () => agentResult()),
    );
    const event = await fixture.tick();
    expect(event, JSON.stringify(event)).toMatchObject({ status: "ok" });
    expect(fixture.reads).toContain("graphql");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(readObservation(runEmbeddedAgentMock.mock.calls[0]![0].prompt).findings).toHaveLength(1);
    fixture.finding.updatedAt = "2026-11-10T14:00:00Z";
    fixture.revokeDevice();
    expect(await fixture.tick()).toMatchObject({ status: "error" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(fixture.execution.getJob(fixture.selected.id)?.enabled).toBe(false);
  },
);

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
  expect(fixture.triggerState()).toBeUndefined();
  expect(fixture.execution.getJob(fixture.selected.id)?.enabled).toBe(false);
});

it("keeps autoMerge on its independently authorized model route", async () => {
  await using fixture = await createFixture("autoMerge");
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async () => {
      expect(params.prompt).toContain("Only when every required gate is satisfied");
      return agentResult();
    }),
  );
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  expect(fixture.reads).not.toContain("graphql");
  expect(fixture.triggerState()).toBeUndefined();
});

it("transports direct UI autoFix for only the selected PR across session replacement and disables future effects", async () => {
  await using fixture = await createFixture("autoFix", true, false, true);
  const effectTarget = (number: number) => ({ owner: "fixture-org", repo: "fixture-repo", number });
  const effect41 = effectTarget(41);
  const finalEffect =
    vi.fn<(target: { owner: string; repo: string; number: number }, sessionId: string) => void>();
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async () => {
      const { owner, repo, number } = readRecipeTarget(params.prompt);
      finalEffect({ owner, repo, number }, params.sessionId);
      return agentResult();
    }),
  );
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
  "addressed-unresolved",
  "reopened-thread",
  "own-publication",
  "pending-publication",
  "direct-pending-publication",
  "direct-inline-device",
  "direct-inline-role",
  "direct-pending-reset",
  "nonthread-addressed",
])("%s: native publication and Cron observation lifecycle", async (mode) => {
  const pendingPublication = mode.includes("pending");
  const direct = mode.startsWith("direct-");
  const inlineRevocation = mode.startsWith("direct-inline-");
  const liveUi = direct && mode !== "direct-pending-publication";
  let revokedAtWrite = false;
  let deviceRemoval: unknown;
  const writes: string[][] = [];
  await using fixture = await createFixture("autoFix", true, false, direct);
  const { pr, graph, workspaceDir, nativeRead, connection, finding, thread, identity } = fixture;
  const { triggerState } = fixture;
  if (mode === "nonthread-addressed") {
    graph.reviewThreads = connection([]);
    graph.comments = connection([finding]);
  }
  const git = (...args: string[]) => fixtureGit(workspaceDir, ...args);
  const sourceHead = pr.head.sha;
  const assertUnpublished = async () => {
    expect(writes).toEqual([]);
    expect(pr.head.sha).toBe(sourceHead);
    expect(await fs.readFile(path.join(workspaceDir, "README.md"), "utf8")).toBe(
      "repair unchecked failure\n",
    );
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  };
  const headCommit = expectDefined(graph.commits.nodes[0], "head commit").commit;
  headCommit.statusCheckRollup = {
    state: "SUCCESS",
    contexts: connection(
      Array.from({ length: mode === "reopened-thread" ? 101 : 1 }, (_, index) => ({
        __typename: "CheckRun",
        id: "verified-check-" + index,
        name: "unit-" + index,
        status: "COMPLETED",
        conclusion: "SUCCESS",
        completedAt: "2026-11-10T10:00:00Z",
      })),
    ),
  };
  const read = nativeRead.getMockImplementation()!;
  const firstRecord = (nodes: unknown) =>
    asRecord(expectDefined(asRecord(nodes)["0"], "fixture first node"));
  const json = (value: unknown) => commandResult(JSON.stringify(value));
  nativeRead.mockImplementation(async (argv, options) => {
    const remoteWrite =
      argv.includes("push") ||
      (argv.includes("POST") && argv.some((arg) => arg.endsWith("/pulls")));
    if (inlineRevocation && remoteWrite && !revokedAtWrite) {
      await git("rev-parse", "HEAD");
      if (mode === "direct-inline-device") {
        deviceRemoval = await fixture.requestFromUi("device.pair.remove", {
          deviceId: fixture.deviceId,
        });
      } else {
        const profile = expectDefined(fixture.profile, "direct requester").id;
        await setCanonicalUserProfileRole(profile, "member");
        invalidateOperatorRolePolicy(profile);
      }
      revokedAtWrite = true;
    }
    if (remoteWrite) {
      expectDefined(options?.beforeRun, "native write authority")();
      writes.push(argv);
    } else {
      options?.beforeRun?.();
    }
    if (argv[0] === "git") {
      if (argv.includes("push")) {
        const refspec = expectDefined(
          argv.find((arg) => /^[a-f0-9]+:refs\/heads\//u.test(arg)),
          "exact push",
        );
        pr.head.sha = expectDefined(refspec.split(":")[0], "pushed head");
        graph.headRefOid = pr.head.sha;
        headCommit.oid = pr.head.sha;
        return json(null);
      }
      if (argv.includes("fetch")) {
        return json(null);
      }
      if (argv.includes("ls-remote")) {
        return { ...json(null), stdout: Buffer.from(`${pr.head.sha}\t${argv.at(-1)}\n`) };
      }
      // All remaining effects are local Git in this private fixture; never run gh.
      return await localCommands.runCommandBuffered(argv, {
        cwd: workspaceDir,
        env: options?.env,
        input: typeof options?.input === "function" ? options.input() : options?.input,
        timeoutMs: 10_000,
      });
    }
    const endpoint = argv.find((arg) => arg.startsWith("repos/"));
    if (endpoint?.endsWith("/pulls/41") && argv.some((arg) => arg.includes("headRepositoryId:"))) {
      return json({
        url: pr.html_url,
        userId: pr.user.id,
        state: pr.state,
        body: "",
        headSha: pr.head.sha,
        headRef: pr.head.ref,
        baseRef: pr.base.ref,
        headRepository: pr.head.repo.full_name,
        headRepositoryId: pr.head.repo.id,
        baseRepository: pr.base.repo.full_name,
        baseRepositoryId: pr.base.repo.id,
      });
    }
    if (endpoint?.includes("/branches/")) {
      return json({
        name: pr.head.ref,
        commit: { sha: pr.head.sha },
        protected: false,
      });
    }
    if (endpoint?.includes("/git/ref/heads/")) {
      return json({ ref: "refs/heads/main", sha: sourceHead });
    }
    if (endpoint?.includes("/git/commits/")) {
      return json(await readPublicationCommit(git, endpoint.split("/").at(-1)!));
    }
    if (endpoint?.includes("/compare/")) {
      const [base, head] = endpoint.split("/compare/")[1]!.split("?")[0]!.split("...");
      return json({
        status: "ahead",
        base: await git("rev-parse", base!),
        mergeBase: await git("merge-base", base!, head!),
        files: (await git("diff", "--name-only", base!, head!)).split("\n").filter(Boolean),
      });
    }
    return read(argv, options);
  });
  publicationCommands.run.mockImplementation(async (argv, options) => {
    if (
      argv[0] === "gh" ||
      (argv[0] === "git" && argv.some((arg) => ["fetch", "push", "ls-remote"].includes(arg)))
    ) {
      return await publicationTransport.runPublicationCommand(argv, {
        ...options,
        maxOutputBytes:
          typeof options?.maxOutputBytes === "number" ? options.maxOutputBytes : undefined,
        input: options?.input === undefined ? undefined : Buffer.from(options.input),
      });
    }
    return localCommands.runCommandBuffered(argv, options);
  });
  const placements = createWorkerSessionPlacementStore();
  const coordinator = createGitHubPublicationCoordinator({
    placements,
    getCommittedRuntimeConfig: fixture.creator.context.getRuntimeConfig,
  });
  fixture.creator.context.githubPublicationService = coordinator;
  const pendingPlacement = pendingPublication
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
      await fs.writeFile(path.join(workspaceDir, "README.md"), "repair unchecked failure\n");
      if (liveUi) {
        return agentResult();
      }
      if (mode === "nonthread-addressed") {
        await git("add", "README.md");
        await git("commit", "-m", "Repair unchecked failure");
      }
      // Native SQLite lease owners use wall time; do not compare their expiries
      // against this scheduler's synthetic five-minute jumps.
      publication = asRecord(
        (await fixture.withWallClock(() => publisher.execute("repair-publication", {}))).details,
      );
      if (pendingPublication) {
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
      thread.isResolved = mode !== "addressed-unresolved";
      await recordJudgment({
        automation,
        url: pr.html_url,
        head: publication.headCommit,
        publicationRequestId: publication.requestId,
        attempt: observation.fingerprint,
        findings: observation.findings.map((observed) => ({
          id: observed.id,
          revision: observed.revision,
          body: observed.body,
          status: "addressed",
          reason: "Repaired unchecked failure in the accepted change",
          quote: finding.body,
          path: "README.md",
        })),
        summary: "Published and verified repair",
      });
      return agentResult();
    }),
  );
  if (direct) {
    await fixture.updateFromUi(true);
  } else {
    await fixture.execution.update(fixture.selected.id, { enabled: true });
  }
  const firstEvent = await fixture.tick();
  // Invoke actual UI ingress outside the scheduled caller’s async scope. Accepted
  // scheduled source is not a live browser request and intentionally outlives it.
  if (liveUi) {
    const response = await fixture.withWallClock(() =>
      fixture.requestFromUi("sessions.github.publish", {
        sessionKey: SESSION,
        agentId: "main",
        idempotencyKey: "repair-publication",
      }),
    );
    if (!inlineRevocation) {
      expect(response.ok, JSON.stringify(response)).toBe(true);
    }
    publication = asRecord(response.payload);
  }
  if (inlineRevocation) {
    if (mode === "direct-inline-device") {
      expect(deviceRemoval, JSON.stringify(deviceRemoval)).toMatchObject({ ok: true });
    }
    expect(revokedAtWrite).toBe(true);
    const receipt = expectDefined(
      await readGitHubPublicationRequestAsync({
        sessionId: SESSION_ID,
        idempotencyKey: "repair-publication",
      }),
      "native request receipt",
    );
    expect(receipt.status).not.toBe("published");
    expect(publication?.status).not.toBe("published");
    await assertUnpublished();
    return;
  }
  expect(firstEvent).toMatchObject({ status: "ok" });
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
    if (mode === "direct-pending-reset") {
      const receipt = { publicationKind: "shared" as const, requestId: String(requestId) };
      const originalLifecycle = await readGitHubPublicationSessionLifecycleInWorker(receipt);
      const before = expectDefined(
        accessor.loadSessionEntryReadOnly(fixture.sessionRef),
        "before reset",
      );
      expect(originalLifecycle).toMatchObject({
        lifecycle_revision: before.lifecycleRevision,
        requester_authority_json: expect.any(String),
      });
      const reset = await fixture.withWallClock(() =>
        performGatewaySessionReset({
          key: SESSION,
          agentId: "main",
          reason: "reset",
          commandSource: "gateway",
          workerPlacementContext: { workerSessionPlacementService: placements },
        }),
      );
      expect(reset.ok, JSON.stringify(reset)).toBe(true);
      const after = expectDefined(
        accessor.loadSessionEntryReadOnly(fixture.sessionRef),
        "after reset",
      );
      expect(after).toMatchObject({ sessionId: before.sessionId, worktree: before.worktree });
      expect(after.lifecycleRevision).not.toBe(before.lifecycleRevision);
      await fixture.withWallClock(() => coordinator.resumeSessionRequests());
      expect(await coordinator.readAsync(String(requestId))).toMatchObject({
        status: "failed",
        code: "session_changed",
        requestId,
      });
      expect(await readGitHubPublicationSessionLifecycleInWorker(receipt)).toEqual(
        originalLifecycle,
      );
      await assertUnpublished();
      return;
    }
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
    expect(triggerState()).toMatchObject({
      pendingRequestId: requestId,
    });
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    await fixture.withWallClock(() => placements.releaseTurn(held));
    // Recovery changes the remote head during this observation. The next bounded
    // observation retries the read, not publication, and keeps the original id.
    await fixture.withWallClock(() => fixture.tick());
    await fixture.withWallClock(() => fixture.tick());
    const recovered = triggerState();
    expect(recovered).toMatchObject({
      publication: { status: "published", requestId, headCommit: pr.head.sha },
    });
    expect(asRecord(recovered).pendingRequestId).toBeNull();
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(
      nativeRead.mock.calls.filter(([argv]) => argv[0] === "git" && argv.includes("push")),
    ).toHaveLength(1);
    return;
  }
  if (mode === "own-publication") {
    const current = structuredClone(
      expectDefined(
        accessor.loadSessionEntryReadOnly(fixture.sessionRef)?.worktree,
        "published worktree",
      ),
    );
    current.githubPullRequest = undefined;
    await accessor.upsertSessionEntryCore(fixture.sessionRef, { worktree: current });
    expect(
      accessor.loadSessionEntryReadOnly(fixture.sessionRef)?.worktree?.githubPullRequest,
    ).toBeUndefined();
  }
  expect(publication).toMatchObject({
    status: "published",
    url: pr.html_url,
    headCommit: pr.head.sha,
  });
  if (mode === "nonthread-addressed" || mode === "reopened-thread") {
    const validRead = expectDefined(nativeRead.getMockImplementation(), "native read");
    const comparisonFaults: Record<string, object> = {
      empty: { files: [] },
      saturated: { files: ["README.md", ...Array.from({ length: 299 }, (_, i) => "file-" + i)] },
      base: { base: "c".repeat(40) },
      ancestry: { mergeBase: "c".repeat(40), status: "diverged" },
      malformed: { files: null },
    };
    const faults =
      mode === "nonthread-addressed"
        ? Object.keys(comparisonFaults)
        : ["head", "count", "duplicate", "cursor", "edited", "transport"];
    for (const fault of faults) {
      let injected = false;
      nativeRead.mockImplementation(async (argv, options) => {
        const result = await validRead(argv, options);
        if (mode === "nonthread-addressed" && argv.some((arg) => arg.includes("/compare/"))) {
          injected = true;
          const comparison = asRecord(JSON.parse(result.stdout.toString()));
          return json({ ...comparison, ...comparisonFaults[fault] });
        }
        const input = typeof options?.input === "function" ? options.input() : options?.input;
        if (argv.includes("graphql") && input) {
          const request = asRecord(JSON.parse(input.toString()));
          if (
            String(request.query).includes("nodes(ids:") &&
            asRecord(request.variables).cursor === "100"
          ) {
            injected = true;
            if (fault === "transport") {
              return { ...result, code: 1 };
            }
            const response = asRecord(JSON.parse(result.stdout.toString()));
            const data = asRecord(response.data);
            const responsePr = asRecord(asRecord(data.repository).pullRequest);
            const commit = asRecord(firstRecord(asRecord(responsePr.commits).nodes).commit);
            const contexts = asRecord(asRecord(commit.statusCheckRollup).contexts);
            const mutations: Record<string, [Record<string, unknown>, object]> = {
              head: [responsePr, { headRefOid: "c".repeat(40) }],
              count: [contexts, { totalCount: 102 }],
              duplicate: [firstRecord(contexts.nodes), { id: "verified-check-0" }],
              cursor: [contexts, { pageInfo: { hasNextPage: true, endCursor: "100" } }],
              edited: [firstRecord(data.nodes), { updatedAt: "2026-11-10T23:00:00Z" }],
            };
            Object.assign(...expectDefined(mutations[fault], "pagination fault"));
            return json(response);
          }
        }
        return result;
      });
      await fixture.tick();
      expect(injected, fault).toBe(true);
      expect(asRecord(triggerState()).dispositions ?? [], fault).toEqual([]);
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    }
    nativeRead.mockImplementation(validRead);
  }
  expect(await fixture.tick()).toBeUndefined();
  const state = asRecord(triggerState());
  expect(state.dispositions).toEqual([
    expect.objectContaining({ status: "addressed", requestId: publication?.requestId }),
  ]);
  fixture.execution.stop();
  await fixture.execution.waitForIdle();
  await fixture.execution.start();
  expect(await fixture.tick()).toBeUndefined();
  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  if (mode === "addressed-unresolved" || mode === "nonthread-addressed") {
    if (mode === "addressed-unresolved") {
      expect(thread.isResolved).toBe(false);
      expect(pr.head.sha).toBe(publication?.headCommit);
      finding.body = "Edited review: the repaired path still needs a timeout";
    }
    finding.updatedAt = "2026-11-10T16:00:00Z";
    expect(await fixture.tick()).toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(asRecord(triggerState()).dispositions).toEqual(state.dispositions);
    return;
  }
  if (mode === "own-publication") {
    // An otherwise eligible App bot's own producer output remains suppressed.
    pr.user.type = "Bot";
    graph.comments = connection([
      {
        ...finding,
        id: "producer-comment",
        authorAssociation: "NONE",
        author: { login: "publisher[bot]", __typename: "Bot", databaseId: 42 },
      },
    ]);
    headCommit.statusCheckRollup = {
      state: "SUCCESS",
      contexts: connection([
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
    const before = triggerState();
    identity.mockResolvedValue({
      source: "system-detected",
      host: "github.com",
      account: { accountId: 77, login: "changed-publisher", avatarUrl: null },
      env: {},
    });
    expect(await fixture.tick()).toMatchObject({
      status: "error",
      error: expect.stringContaining("identity changed"),
    });
    expect(triggerState()).toEqual(before);
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
    return;
  }
  thread.isResolved = false;
  expect(await fixture.tick()).toMatchObject({ status: "ok" });
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
  const reopened = asRecord(triggerState());
  expect(reopened.dispositions).toEqual([]);
  expect(reopened.quietFindings).toEqual([]);
  expect(reopened.disposition).toMatchObject({ status: "blocked" });
  // This reopened dispatch has the same fingerprint, but is a new occurrence.
  // Observing the old turn does not establish this turn's missing outcome.
  await fixture.expireRunHistory();
  expect(
    fixture.runHistory(`cron:${fixture.selected.id}:${String(asRecord(reopened.attempt).atMs)}`),
  ).toEqual([]);
  await fixture.execution.start();
  await fixture.expectQuietTicks(12);
  expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
  expect(triggerState()).toMatchObject({
    dispositions: [],
    blocked: expect.stringContaining("manual review"),
  });
});
