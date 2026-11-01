import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as entryMutations from "../../config/sessions/session-accessor.sqlite-entry.js";
import { resetSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  resolveLocalWorkspaceOwner,
  reuseLocalWorkspaceProjection,
  withLocalWorkspaceProjection,
} from "../worker-environments/local-workspace-projection.js";
import { readLocalWorkspaceProjection } from "../worker-environments/local-workspace-store.test-support.js";
import { expectCutReply } from "./sessions-rewind.handler.test-support.js";
import {
  cfg,
  invokeMessageCut,
  seedMessageCutSource,
  useMessageCutStorageFixture,
} from "./sessions-rewind.storage.test-support.js";

useMessageCutStorageFixture();

it.each([
  { method: "sessions.rewind", failure: "none" },
  { method: "sessions.branches.switch", failure: "none" },
  { method: "sessions.rewind", failure: "conflict" },
  { method: "sessions.rewind", failure: "revoked commit" },
  { method: "sessions.rewind", failure: "receipt cleanup" },
  { method: "sessions.rewind", failure: "next cut before adoption" },
  { method: "sessions.rewind", failure: "reset before adoption" },
] as const)(
  "preserves the managed sandbox across $method ($failure)",
  async ({ method, failure }) => {
    await withOpenClawTestState({ label: "message-cut-local-workspace" }, async (state) => {
      await state.writeConfig(cfg);
      const scope = await seedMessageCutSource();
      const repo = state.path("source");
      const canonical = state.path("canonical");
      const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
      await fs.mkdir(repo);
      await git(repo, "init", "--quiet", "-b", "main");
      await git(repo, "config", "user.name", "Test");
      await git(repo, "config", "user.email", "test@example.invalid");
      await fs.writeFile(path.join(repo, "source.txt"), "original\n");
      await fs.writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "--quiet", "-m", "base");
      await git(repo, "worktree", "add", "--quiet", "-b", "openclaw/guest", canonical);
      const worktree = {
        id: randomUUID(),
        name: "guest",
        repoFingerprint: "test",
        repoRoot: repo,
        path: canonical,
        branch: "openclaw/guest",
        baseRef: "main",
        ownerKind: "session" as const,
        ownerId: scope.sessionKey,
        createdAt: 0,
        lastActiveAt: 0,
      };
      await insertRegistryWorktree(state.env, worktree);
      await patchSessionEntryCore(scope, (entry) => ({
        ...entry,
        worktree: { id: worktree.id, branch: worktree.branch, repoRoot: repo },
        spawnedCwd: canonical,
      }));
      using original = expectDefined(
        await resolveLocalWorkspaceOwner({ cfg, ...scope }),
        "managed workspace owner",
      );
      const projection = await withLocalWorkspaceProjection(original, (workspace) =>
        workspace.prepare(),
      );
      await fs.writeFile(path.join(projection, "source.txt"), "stopped turn edit\n");
      await fs.writeFile(path.join(projection, "ignored.txt"), "guest-only ignored data\n");
      if (failure === "conflict" || failure === "revoked commit") {
        let current = true;
        const assertCurrent = () => {
          if (!current) {
            throw new Error("cut cancelled");
          }
        };
        const admission =
          failure === "revoked commit"
            ? probe.admission(workerAdmission, (request, grant, callback) => {
                if (
                  request.stage === "commit" &&
                  isRecord(request.facts) &&
                  isRecord(request.facts.publication) &&
                  request.facts.publication.kind === "session-entry-patch-committed"
                ) {
                  current = false;
                }
                callback(request, grant);
              })
            : undefined;
        if (failure === "conflict") {
          await fs.writeFile(path.join(canonical, "source.txt"), "host conflict\n");
        }
        const rejected = invokeMessageCut(method, scope, {
          sessionMutationCommitGuard: assertCurrent,
        });
        await rejected.error;
        admission?.mockRestore();
        expect(rejected.respond).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
        expect((await readSessionEntryReadOnlyInWorker(scope))?.sessionId).toBe(scope.sessionId);
        original.assertCurrent();
        expect(await fs.readFile(path.join(projection, "source.txt"), "utf8")).toBe(
          "stopped turn edit\n",
        );
        if (failure === "conflict") {
          expect((await readLocalWorkspaceProjection(worktree.id))?.pending_ref).toBeTruthy();
          expect(await fs.readFile(path.join(canonical, "source.txt"), "utf8")).toBe(
            "host conflict\n",
          );
          await fs.writeFile(path.join(canonical, "source.txt"), "original\n");
        } else {
          expect(current).toBe(false);
        }
      }
      const cut = invokeMessageCut(method, scope);
      expect(await cut.error).toBeUndefined();
      expectCutReply(
        cut.respond,
        method === "sessions.rewind" ? { editorText: "What did I say?" } : {},
      );
      expect(() => original.assertCurrent()).toThrow("authority changed");
      let committed = expectDefined(
        await readSessionEntryReadOnlyInWorker(scope),
        "committed session",
      );
      expect(committed.localWorkspaceHandoff?.fromSessionId).toBe(scope.sessionId);
      expect(projectPublicSessionEntry(committed)).not.toHaveProperty("localWorkspaceHandoff");
      const settled = expectDefined(
        await readLocalWorkspaceProjection(worktree.id),
        "saved projection",
      );
      expect(settled.session_id).toBe(scope.sessionId);
      expect(await fs.readFile(path.join(canonical, "source.txt"), "utf8")).toBe(
        "stopped turn edit\n",
      );
      if (failure === "next cut before adoption") {
        const next = invokeMessageCut("sessions.branches.switch", scope);
        expect(await next.error).toBeUndefined();
        expectCutReply(next.respond, {});
        const firstSuccessor = committed.sessionId;
        committed = expectDefined(
          await readSessionEntryReadOnlyInWorker(scope),
          "committed session",
        );
        expect(committed.localWorkspaceHandoff?.fromSessionId).toBe(firstSuccessor);
      } else if (failure === "reset before adoption") {
        await resetSessionEntryLifecycle({
          agentId: scope.agentId,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
          storePath: resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
          buildNextEntry: ({ currentEntry }) => ({
            ...expectDefined(currentEntry, "reset source"),
            lifecycleRevision: randomUUID(),
          }),
        });
      }
      if (failure === "receipt cleanup") {
        const cleanup = vi
          .spyOn(entryMutations, "patchSessionEntryCore")
          .mockRejectedValueOnce(new Error("cleanup interrupted"));
        await expect(resolveLocalWorkspaceOwner({ cfg, ...scope })).rejects.toThrow(
          "cleanup interrupted",
        );
        cleanup.mockRestore();
        expect((await readLocalWorkspaceProjection(worktree.id))?.session_id).toBe(
          committed.sessionId,
        );
      } else if (method === "sessions.rewind" && failure === "none") {
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
      }
      using resumed = expectDefined(
        await resolveLocalWorkspaceOwner({ cfg, ...scope }),
        "managed workspace owner",
      );
      expect(resumed.sessionId).not.toBe(scope.sessionId);
      expect(
        (await readSessionEntryReadOnlyInWorker(scope))?.localWorkspaceHandoff,
      ).toBeUndefined();
      expect((await readLocalWorkspaceProjection(worktree.id))?.baseline_ref).toBe(
        settled.baseline_ref,
      );
      await appendTranscriptMessage(
        { ...scope, sessionId: resumed.sessionId },
        {
          eventId: "edited-resend",
          message: { role: "user", content: "Edited and resent." },
        },
      );
      expect(
        (await loadTranscriptEvents({ ...scope, sessionId: resumed.sessionId })).some(
          (event) => isRecord(event) && event.id === "edited-resend",
        ),
      ).toBe(true);
      for (let retry = 0; retry < 2; retry++) {
        expect(await reuseLocalWorkspaceProjection(resumed)).toBe(projection);
      }
      expect(await fs.readFile(path.join(projection, "ignored.txt"), "utf8")).toBe(
        "guest-only ignored data\n",
      );
      expect((await readLocalWorkspaceProjection(worktree.id))?.session_id).toBe(resumed.sessionId);
      await expect(
        withLocalWorkspaceProjection({ ...resumed, sessionId: randomUUID() }, (workspace) =>
          workspace.prepare(),
        ),
      ).rejects.toThrow("different session incarnation");
    });
  },
);
