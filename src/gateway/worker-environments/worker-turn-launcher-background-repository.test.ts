import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import {
  resolveSessionSkillResourceSandboxInputs,
  resolveSessionSkillResourceSnapshot,
} from "../../agents/session-placement-skill-resources.js";
import { createSyntheticSourceInfo } from "../../agents/sessions/source-info.js";
import { getRuntimeConfig } from "../../config/config.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveWorkerPlacementSessionTarget } from "../server-worker-placement-session-target.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../session-utils-store-lookup.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "../session-utils-store.js";
import {
  attachedEnvironment,
  createWorkerSessionTurnPlacementProvider,
  placements,
  root,
  SESSION_ID,
  sessionTarget,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";
import { useRepositoryWorkspaceResultFixture } from "./workspace-result-repository.test-support.js";

const diagnostics = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (name: string) => {
      const logger = original.createSubsystemLogger(name);
      return name === "gateway/worker-placement" ? { ...logger, info: diagnostics.info } : logger;
    },
  };
});

// The repository fixture uses a local origin; no GitHub account or network is involved.
vi.mock("./worker-github-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-github-binding.js")>()),
  prepareWorkerRepositoryGitHubIdentity: async () => ({
    token: undefined,
    selection: { source: "anonymous" },
    cacheScope: "anonymous",
    assertSelected: () => {},
    revalidate: async () => {},
    start: (operation: () => unknown) => Promise.resolve(operation()),
  }),
  prepareWorkerGitHubBindingGrant: async () => undefined,
}));

describe("launcher background repository readiness", () => {
  const { fixture } = useRepositoryWorkspaceResultFixture();

  it.for(["none", "native", "gateway"] as const)(
    "invokes the runner before repository sync (native skill catalog: %s)",
    async (nativeSkills, { signal }) => {
      const f = await fixture("remote-exec", false, false, true);
      diagnostics.info.mockClear();
      const modelEntered = createDeferredCore();
      const resumeSync = createDeferredCore();
      const repositoryCommand = createDeferredCore();
      const execute = f.tunnel.runWorkspaceCommand.bind(f.tunnel);
      f.tunnel.runWorkspaceCommand = (command) => {
        repositoryCommand.resolve();
        return execute(command);
      };
      const provider = createWorkerSessionTurnPlacementProvider({
        environments: {
          ...unusedEnvironments(),
          ...f.environments,
          get: () => ({
            ...attachedEnvironment(),
            sshEndpoint: null,
            nodeDeviceId: "resource-node",
          }),
        },
        placements,
        workspaceOperations: f.workspaceOperations,
        reconcileActivePlacement: async () => {
          throw new Error(placements.get(SESSION_ID)?.recoveryError ?? "Unexpected reconciliation");
        },
        resolveWorkspace: async (identity) => {
          const selected = await resolveWorkerPlacementSessionTarget({
            sessionRuntime: {
              resolveGatewaySessionStoreTargetWithStore,
              resolveCanonicalSessionEntryFromStoreKeys,
              managedWorktrees: { findLiveByOwner: () => undefined },
            },
            config: getRuntimeConfig(),
            ...identity,
            errorMessage: "Repository session changed before turn",
          });
          selected.assertCurrent();
          return selected.workspace;
        },
      });
      let syncPublished = false;
      let commandCompleted = false;
      let resourcesRead = false;
      const sync = (async () => {
        await resumeSync.promise;
        const synced = await f.syncRepository();
        const placement = placements.get(SESSION_ID);
        if (placement?.state !== "active") {
          throw new Error("Fixture repository lost active placement");
        }
        await placements.settleRepository(
          {
            ...sessionTarget,
            environmentId: placement.environmentId,
            ownerEpoch: placement.activeOwnerEpoch,
            expectedGeneration: placement.generation,
            status: "ready",
            manifestRef: synced.manifestRef,
          },
          () => {},
        );
        await f.tunnel.settleRepositoryWorkspace!(
          "ready",
          synced.mode === "repository" ? synced.baseCommit : undefined,
        );
        syncPublished = true;
      })();
      void sync.catch(() => {});
      const filePath =
        nativeSkills === "native"
          ? "node://worker/skills/worker-skill/SKILL.md"
          : path.join(root, "skill", "SKILL.md");
      if (nativeSkills === "gateway") {
        await fs.mkdir(path.dirname(filePath));
        await fs.writeFile(filePath, "# Synthetic skill\nRead data.txt.\n");
        await fs.writeFile(path.join(path.dirname(filePath), "data.txt"), "verified resource");
      }
      const skillsSnapshot: SkillSnapshot | undefined =
        nativeSkills === "none"
          ? undefined
          : {
              prompt: "Worker skill",
              skills: [{ name: "worker-skill" }],
              resolvedSkills: [
                {
                  name: "worker-skill",
                  description: "Worker skill",
                  filePath,
                  baseDir: path.dirname(filePath),
                  source: "test",
                  sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
                  disableModelInvocation: false,
                  ...(nativeSkills === "gateway" ? { fileHost: "gateway" as const } : {}),
                },
              ],
            };
      const operation = provider.executeTurn(
        { ...sessionTarget, runId: "held-repository-sync" },
        { ...turn("held-repository-sync"), prompt: "do-not-retain-user-input", skillsSnapshot },
        async () => {
          expect(syncPublished).toBe(false);
          modelEntered.resolve();
          const inputs = resolveSessionSkillResourceSandboxInputs();
          const snapshot = resolveSessionSkillResourceSnapshot(skillsSnapshot);
          const resource =
            nativeSkills === "gateway"
              ? inputs!
                  .skillResources!.readInstructions(snapshot!.resolvedSkills![0]!.filePath, {
                    signal,
                  })
                  .then((content) => {
                    expect(content).toBe("# Synthetic skill\nRead data.txt.\n");
                    resourcesRead = true;
                  })
              : Promise.resolve();
          if (nativeSkills === "gateway") {
            expect(inputs?.resourceReadiness).toBeDefined();
          }
          const command = await f.tunnel.runWorkspaceCommand({
            argv: [
              "node",
              "-e",
              "process.stdout.write(require('node:child_process').execFileSync('git',['branch','--show-current']))",
            ],
            signal,
            transportRetry: "never",
          });
          commandCompleted = true;
          expect(command.code).toBe(0);
          expect(command.stdout.trim()).toBe(f.repository.branch);
          await resource;
          await sync;
          return { meta: { durationMs: 1 } };
        },
      );
      void operation.catch(() => {});
      try {
        if (nativeSkills === "gateway") {
          await withinTest(modelEntered.promise, signal);
          expect(resourcesRead).toBe(false);
        } else {
          expect(
            await withinTest(
              Promise.race([
                modelEntered.promise.then(() => "model"),
                repositoryCommand.promise.then(() => "repository-command"),
              ]),
              signal,
            ),
          ).toBe("model");
        }
        const events = diagnostics.info.mock.calls
          .filter(([message]) => message === "worker placement stage")
          .map(([, facts]) => facts);
        expect(events.map(({ stage }) => stage)).toEqual([
          "turn_placement_read_started",
          "turn_placement_read_completed",
          "turn_workspace_resolve_started",
          "turn_workspace_resolve_completed",
          "turn_workspace_recovery_started",
          "turn_workspace_recovery_completed",
          "turn_tunnel_started",
          "turn_tunnel_completed",
          "turn_attachments_started",
          "turn_attachments_completed",
          "turn_skill_resources_started",
          "turn_skill_resources_completed",
          "turn_computer_started",
          "turn_computer_completed",
          "turn_runner_invoked",
        ]);
        for (const event of events) {
          expect(event).toMatchObject({ sessionId: SESSION_ID, runId: "held-repository-sync" });
          expect(event.monotonicAtMs).toEqual(expect.any(Number));
          if (!event.stage.startsWith("turn_placement_read")) {
            expect(event).toMatchObject({
              environmentId: f.tunnel.environmentId,
              ownerEpoch: f.tunnel.ownerEpoch,
              claimId: placements.get(SESSION_ID)?.turnClaim?.claimId,
            });
          }
          if (event.stage.endsWith("_completed")) {
            expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
          }
        }
        expect(JSON.stringify(events)).not.toContain("do-not-retain-user-input");
        expect(JSON.stringify(events)).not.toContain(f.repository.url);
        expect(commandCompleted).toBe(false);
        resumeSync.resolve();
        await expect(operation).resolves.toMatchObject({ meta: { durationMs: 1 } });
        expect(syncPublished).toBe(true);
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      } finally {
        resumeSync.resolve();
        await sync.catch(() => {});
        await operation.catch(() => {});
      }
    },
  );
});
