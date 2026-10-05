import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { registerProjectRegistry } from "../../../projects/project-registry.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { normalizeAcceptedSessionSpawnResult } from "../../accepted-session-spawn.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import { managedWorktrees } from "../../worktrees/service.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { cleanupProvisionalSession } from "./subagent-spawn-cleanup.js";
import {
  createBoundSpawnInvocation,
  type createSpawnBoundaryParent,
} from "./subagent-spawn.production-boundary.test-support.js";

type BoundParent = Awaited<ReturnType<typeof createSpawnBoundaryParent>>;

export function registerManagedWorktreeSpawnCases(options: {
  stateDir: () => string;
  createBoundParent: () => Promise<BoundParent>;
  createBoundGateway: (bound: BoundParent) => Promise<{
    context: GatewayRequestContext;
    runtime: ReturnType<typeof createGatewayInstanceRuntime>;
  }>;
  runEmbeddedAgent: Mock<typeof import("../../embedded-agent.js").runEmbeddedAgent>;
  settleRegistry: () => Promise<void>;
}) {
  const { createBoundParent, createBoundGateway, runEmbeddedAgent } = options;
  describe("managed worktrees", () => {
    let repository = "";
    let projectId = "";
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
    let preparationStarted = createDeferred();
    let releasePreparation = createDeferred();
    let modelStarted = createDeferred();
    let modelResult = createDeferred<EmbeddedAgentRunResult>();
    let ownedBound: BoundParent | undefined;
    let ownedGateway: Awaited<ReturnType<typeof createBoundGateway>> | undefined;
    let setup: Promise<void> | undefined;
    let spawn: ReturnType<ReturnType<typeof createBoundSpawnInvocation>> | undefined;
    let restoreAllocation: (() => void) | undefined;
    let childSessionKey: string | undefined;

    beforeEach(async ({ signal }) => {
      repository = path.join(options.stateDir(), "source");
      projectId = "";
      ownedBound = undefined;
      ownedGateway = undefined;
      spawn = undefined;
      restoreAllocation = undefined;
      childSessionKey = undefined;
      preparationStarted = createDeferred();
      releasePreparation = createDeferred();
      modelStarted = createDeferred();
      modelResult = createDeferred<EmbeddedAgentRunResult>();
      setup = (async () => {
        signal.throwIfAborted();
        await fs.mkdir(repository);
        git("init", "-b", "main");
        await fs.writeFile(path.join(repository, "README.md"), "synthetic source\n");
        git("add", "README.md");
        git(
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "fixture",
        );
        signal.throwIfAborted();
        const project = await registerProjectRegistry({ path: repository, name: "Spawn fixture" });
        projectId = project.id;
        signal.throwIfAborted();
        ownedBound = await createBoundParent();
        signal.throwIfAborted();
        ownedGateway = await createBoundGateway(ownedBound);
        signal.throwIfAborted();
        const allocate = managedWorktrees.createWithOutcome.bind(managedWorktrees);
        const allocation = vi
          .spyOn(managedWorktrees, "createWithOutcome")
          .mockImplementationOnce(async (params) => {
            preparationStarted.resolve();
            await releasePreparation.promise;
            return allocate(params);
          });
        restoreAllocation = () => allocation.mockRestore();
        runEmbeddedAgent.mockImplementationOnce(() => {
          modelStarted.resolve();
          return modelResult.promise;
        });
      })();
      await withinTest(setup, signal);
    });

    afterEach(async ({ signal }) => {
      releasePreparation.resolve();
      modelResult.resolve({ payloads: [], meta: { durationMs: 1 } });
      // A timeout can precede admission. Join started setup and spawn before
      // observing idle so neither can launch work after the Gateway closes.
      await setup?.catch(() => undefined);
      if (signal.aborted) {
        ownedBound?.parent.controller.abort(signal.reason);
      }
      const settledSpawn = await spawn?.catch(() => undefined);
      childSessionKey ??= normalizeAcceptedSessionSpawnResult(settledSpawn)?.childSessionKey;
      try {
        const bound = ownedBound;
        const gateway = ownedGateway;
        if (bound) {
          await AsyncWorkScope.runWhenAllIdle(
            () => [bound.execution],
            () => {},
          );
        }
        if (bound && gateway && childSessionKey) {
          const entry = loadSessionEntry({
            storePath: bound.storePath,
            sessionKey: childSessionKey,
          });
          if (entry) {
            const cleanupKey = childSessionKey;
            const deleted = await withPluginRuntimeGatewayRequestScope(
              { context: gateway.context, isWebchatConnect: () => false },
              () =>
                cleanupProvisionalSession(cleanupKey, {
                  expectedSessionId: entry.sessionId,
                  expectedLifecycleRevision: entry.lifecycleRevision,
                }),
            );
            expect(deleted, "retained child cleanup through the fixture Gateway").toBe(true);
          }
        }
      } finally {
        try {
          const bound = ownedBound;
          if (bound) {
            await AsyncWorkScope.runWhenAllIdle(
              () => [bound.execution],
              () => bound.execution.drain(),
            );
          }
        } finally {
          restoreAllocation?.();
          ownedGateway?.runtime.close();
          await ownedBound?.admission.close();
          ownedBound?.parent.cleanup();
          ownedBound = undefined;
          ownedGateway = undefined;
          setup = undefined;
        }
      }
    });

    it.for(["keep", "delete"] as const)(
      "runs a hidden managed worktree with cleanup=%s",
      async (cleanup, { signal }) => {
        const bound = expectDefined(ownedBound, "prepared Gateway parent");
        signal.throwIfAborted();
        spawn = createBoundSpawnInvocation(bound, {
          visible: false,
          context: "isolated",
          projectId,
          worktree: true,
          worktreeName: `hidden-${cleanup}`,
          worktreeBaseRef: "main",
          cleanup,
          ...(cleanup === "keep"
            ? { completionTarget: "parent" }
            : { expectsCompletionMessage: false }),
        })();
        const spawned = await withinTest(spawn, signal);
        expect(spawned.details).toMatchObject({ status: "accepted", context: "isolated" });
        const details = expectDefined(
          normalizeAcceptedSessionSpawnResult(spawned),
          "accepted spawn",
        );
        childSessionKey = details.childSessionKey;
        const childScope = { storePath: bound.storePath, sessionKey: childSessionKey };
        expect(childSessionKey).toContain(":subagent:");
        expect(loadSessionEntry(childScope)).toMatchObject({
          projectId,
          pendingWorktree: { name: `hidden-${cleanup}`, baseRef: "main" },
          spawnDepth: 2,
        });
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        const executionIdle = AsyncWorkScope.runWhenAllIdle(
          () => [bound.execution],
          () => {},
        );
        await withinTest(
          awaitGateBeforeSettlement(
            preparationStarted.promise,
            executionIdle,
            "Child ended before workspace preparation",
          ),
          signal,
        );
        releasePreparation.resolve();
        await withinTest(
          awaitGateBeforeSettlement(
            modelStarted.promise,
            executionIdle,
            "Child ended before model entry",
          ),
          signal,
        );
        const child = loadSessionEntry(childScope);
        const checkout = expectDefined(
          managedWorktrees.findLiveByOwner("session", childSessionKey),
          "child managed worktree",
        );
        expect(checkout).toMatchObject({
          branch: `openclaw/hidden-${cleanup}`,
          ownerKind: "session",
        });
        expect(child).toMatchObject({
          spawnedCwd: checkout.path,
          sessionRoot: checkout.path,
          worktree: { id: checkout.id, branch: checkout.branch, repoRoot: repository },
        });
        expect(child?.pendingWorktree).toBeUndefined();
        expect(runEmbeddedAgent.mock.calls[0]?.[0].workspaceDir).toBe(checkout.path);
        expect(
          execFileSync("git", ["-C", checkout.path, "branch", "--show-current"], {
            encoding: "utf8",
          }).trim(),
        ).toBe(checkout.branch);
        expect(subagentRuns.get(details.runId)).toMatchObject({
          cleanup,
          requesterSessionKey: bound.parentSessionKey,
          ...(cleanup === "keep" ? { completionTarget: "parent" } : {}),
        });
        await fs.writeFile(path.join(checkout.path, "result.txt"), "preserve this result\n");
        modelResult.resolve({ payloads: [{ text: "done" }], meta: { durationMs: 1 } });
        await withinTest(executionIdle, signal);
        await withinTest(options.settleRegistry(), signal);
        if (cleanup === "delete") {
          expect(loadSessionEntry(childScope)).toBeUndefined();
          await expect(fs.stat(checkout.path)).rejects.toMatchObject({ code: "ENOENT" });
          expect(git("show", `refs/openclaw/snapshots/${checkout.id}:result.txt`)).toBe(
            "preserve this result",
          );
        } else {
          expect(loadSessionEntry(childScope)?.worktree?.id).toBe(checkout.id);
          expect(await fs.readFile(path.join(checkout.path, "result.txt"), "utf8")).toBe(
            "preserve this result\n",
          );
        }
      },
    );
  });
}
