import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveWorkerPlacementSessionTarget } from "../../gateway/server-worker-placement-session-target.js";
import { createWorktreeSpawnRepositoryFixture } from "../../gateway/server.sessions.create-worktree-spawn.test-support.js";
import { createGatewaySession } from "../../gateway/session-create-service.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../../gateway/session-utils-store-lookup.js";
import { resolveCanonicalSessionEntryFromStoreKeys } from "../../gateway/session-utils-store.js";
import { prepareSessionWorktree } from "../../gateway/session-worktree-preparation.js";
import { registerProjectRegistry } from "../../projects/project-registry.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState } from "./session.js";

describe("reply reset with a native session worktree", () => {
  it.each([
    { body: "/new hello", project: false },
    { body: "/reset", project: true },
    { body: "continue after idle", project: true },
  ])("keeps the checkout after $body", async ({ body, project }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:dashboard:worktree-reset";
      const cfg: OpenClawConfig = {
        session: { reset: { mode: "idle", idleMinutes: 1 } },
      };
      const repository = project
        ? await createWorktreeSpawnRepositoryFixture(state.path("seeds"))(state.root, "project")
        : undefined;
      const selection = repository
        ? await registerProjectRegistry({ path: repository })
        : undefined;
      const sourceWorkspace = repository ? path.join(repository, "packages", "app") : undefined;
      if (sourceWorkspace) {
        await fs.mkdir(sourceWorkspace, { recursive: true });
      }
      const created = await createGatewaySession({
        cfg,
        key: sessionKey,
        projectId: selection?.id,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        prepareLifecycle: async (target) =>
          await prepareSessionWorktree({
            cfg,
            target,
            workspace: sourceWorkspace ?? { kind: "empty" },
            runSetupScript: false,
          }),
      });
      if (!created.ok) {
        throw new Error(created.error.message);
      }
      const native = managedWorktrees.findLiveByOwner("session", sessionKey);
      expect(native).toMatchObject({ ownerKind: "session", ownerId: sessionKey });
      if (!native) {
        throw new Error("Native session checkout was not created");
      }
      const file = path.join(native.path, "unfinished.txt");
      await fs.writeFile(file, "keep unfinished work\n");
      const idle = !body.startsWith("/");
      if (idle) {
        const expired = Date.now() - 120_000;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { updatedAt: expired, sessionStartedAt: expired, lastInteractionAt: expired },
        );
      }
      const initialized = await initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: finalizeInboundContext({
          Body: body,
          RawBody: body,
          CommandBody: body,
          ChatType: "direct",
          SessionKey: sessionKey,
          Provider: "webchat",
          Surface: "webchat",
        }),
      });
      expect(initialized.isNewSession).toBe(true);
      expect(initialized.resetTriggered).toBe(!idle);
      expect(initialized.sessionKey).toBe(sessionKey);
      const runWorkspace = project ? path.join(native.path, "packages", "app") : native.path;
      const retained = loadSessionEntry({ agentId: "main", sessionKey, readConsistency: "latest" });
      expect(retained).toMatchObject({
        worktree: created.entry.worktree,
        spawnedCwd: runWorkspace,
        sessionRoot: native.path,
      });
      expect(retained?.projectId).toBe(selection?.id);
      // Consume the committed row exactly as the next local run and worker placement do.
      expect(
        resolveIngressWorkspaceOverrideForSessionRun({
          spawnedBy: retained?.spawnedBy,
          workspaceDir: retained?.spawnedWorkspaceDir,
          cwd: retained?.spawnedCwd,
        }),
      ).toBe(runWorkspace);
      const placement = resolveWorkerPlacementSessionTarget({
        sessionRuntime: {
          resolveGatewaySessionStoreTargetWithStore,
          resolveCanonicalSessionEntryFromStoreKeys,
          managedWorktrees,
        },
        config: cfg,
        sessionId: initialized.sessionId,
        sessionKey,
        agentId: "main",
        errorMessage: "Reset detached the session workspace",
      });
      expect(placement.workspace).toEqual({ kind: "local", path: native.path });
      expect(managedWorktrees.findLiveByOwner("session", sessionKey)).toEqual(native);
      expect(await fs.readFile(file, "utf8")).toBe("keep unfinished work\n");
    });
  });
});
