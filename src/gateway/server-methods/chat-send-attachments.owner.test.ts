import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { insertRegistryWorktree, updateRegistryWorktree } from "../../agents/worktrees/registry.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readLocalWorkspaceProjection } from "../worker-environments/local-workspace-store.test-support.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";

it.each(["off", "all"] as const)(
  "prepares both owners' global attachments with sandbox %s",
  async (mode) => {
    await withOpenClawTestState({ label: "gateway-media-owner" }, async (state) => {
      await loadOrCreateProcessDeviceIdentityAsync();
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: {
            main: { workspace: state.path("main") },
            work: { workspace: state.path("work") },
          },
          defaults: {
            skipBootstrap: true,
            sandbox: {
              mode,
              scope: "agent" as const,
              workspaceRoot: state.path("sandboxes"),
              workspaceAccess: "none" as const,
            },
          },
        },
        session: { scope: "global" as const },
      };
      const paths: string[] = [];
      for (const agentId of ["main", "work"]) {
        const bytes = `${agentId} attachment contents`;
        const fileName = "notes café 雪 🦞.txt";
        const request = await normalizeChatSendRequest({
          client: null,
          params: {
            agentId,
            sessionKey: "global",
            message: "read the file",
            idempotencyKey: `media-${agentId}`,
            attachments: [
              {
                fileName,
                mimeType: "text/plain",
                content: Buffer.from(bytes).toString("base64"),
              },
            ],
          },
        });
        expect(request.ok).toBe(true);
        if (!request.ok) {
          throw new Error(request.error);
        }
        const respond = vi.fn();
        const controller = new AbortController();
        const result = await prepareChatSendAttachments({
          request: request.value,
          session: {
            cfg,
            sessionKey: "global",
            agentId,
            resolvedSessionModel: { provider: "fixture", model: "fixture" },
            clientRunId: `media-${agentId}`,
          },
          admission: {
            activeRunAbort: { controller },
            assertWorkAdmissionCurrent: () => controller.signal.throwIfAborted(),
            cleanupAdmittedRun() {},
          },
          context: { logGateway: createSubsystemLogger("test/media-owner") },
          respond,
        } as unknown as Parameters<typeof prepareChatSendAttachments>[0]);
        expect(respond.mock.calls).toEqual([]);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("attachment preparation failed");
        }
        const media = result.value.mediaPathOffloads[0]!;
        expect(media.fileName).toBe(fileName);
        const file = path.resolve(media.workspaceDir!, media.path!);
        expect(await fs.readFile(file, "utf8")).toBe(bytes);
        paths.push(file);
        if (mode === "all") {
          expect(file.startsWith(state.path("sandboxes"))).toBe(true);
        }
      }
      expect(paths[0]).not.toBe(paths[1]);
    });
  },
);

it("stages managed session follow-ups in their projection and rejects unrelated workspaces", async () => {
  await withOpenClawTestState({ label: "managed-chat-attachment" }, async (state) => {
    await loadOrCreateProcessDeviceIdentityAsync();
    const repository = state.path("repository");
    const checkout = state.path("checkout");
    await fs.mkdir(repository);
    await requireGit(repository, ["init", "--quiet", "-b", "main"]);
    await requireGit(repository, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "base",
    ]);
    await requireGit(repository, ["worktree", "add", "--quiet", "-b", "openclaw/guest", checkout]);
    const sessionKey = "agent:main:dashboard:managed-attachment";
    const worktree = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "guest",
      repoFingerprint: "synthetic-attachment-repository",
      repoRoot: repository,
      path: checkout,
      branch: "openclaw/guest",
      baseRef: "main",
      ownerKind: "session" as const,
      ownerId: sessionKey,
      createdAt: 1,
      lastActiveAt: 1,
    };
    await insertRegistryWorktree(process.env, worktree);
    const cfg = {
      worktreeAcceleration: false,
      agents: {
        entries: { main: { workspace: state.workspaceDir } },
        defaults: {
          skipBootstrap: true,
          sandbox: { mode: "off", backend: "docker", workspaceAccess: "none" },
        },
      },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(cfg);
    const entry = {
      sessionId: "managed-attachment-session",
      updatedAt: 1,
      sandbox: "required" as const,
      spawnedCwd: checkout,
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: repository },
    };
    await upsertSessionEntryCore({ agentId: "main", sessionKey }, entry);
    for (const selection of ["cwd", "workspace", "unrelated", "removed"] as const) {
      if (selection === "removed") {
        await updateRegistryWorktree(process.env, worktree.id, { removedAt: 2 });
      }
      const selectedEntry = {
        ...entry,
        spawnedCwd: selection === "cwd" || selection === "removed" ? checkout : state.workspaceDir,
        ...(selection === "workspace"
          ? { spawnedBy: "agent:main:parent", spawnedWorkspaceDir: checkout }
          : {}),
      };
      const request = await normalizeChatSendRequest({
        client: null,
        params: {
          sessionKey,
          message: "read the selection comment",
          idempotencyKey: `managed-${selection}`,
          attachments: [
            {
              fileName: "selection-comment.txt",
              mimeType: "text/plain",
              content: Buffer.from("Please clarify this selection.").toString("base64"),
            },
          ],
        },
      });
      if (!request.ok) {
        throw new Error(request.error);
      }
      const respond = vi.fn();
      const controller = new AbortController();
      const result = await prepareChatSendAttachments({
        request: request.value,
        session: {
          cfg,
          sessionKey,
          agentId: "main",
          entry: { ...entry, spawnedCwd: state.workspaceDir },
          resolvedSessionModel: { provider: "fixture", model: "fixture" },
          clientRunId: `managed-${selection}`,
        },
        admission: {
          activeRunAbort: { controller, cleanup() {} },
          admittedSessionEntry: selectedEntry,
          assertWorkAdmissionCurrent: () => controller.signal.throwIfAborted(),
          cleanupAdmittedRun() {},
        },
        context: { logGateway: createSubsystemLogger("test/managed-media") },
        respond,
      } as unknown as Parameters<typeof prepareChatSendAttachments>[0]);
      if (selection === "unrelated" || selection === "removed") {
        expect(result.ok).toBe(false);
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: expect.stringContaining("Local sandbox managed workspace owner changed"),
          }),
        );
        continue;
      }
      expect(respond.mock.calls).toEqual([]);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("managed attachment preparation failed");
      }
      const media = result.value.mediaPathOffloads[0]!;
      const projection = await readLocalWorkspaceProjection(worktree.id);
      expect(projection?.session_key).toBe(sessionKey);
      expect(media.workspaceDir).toBe(projection?.projection_path);
      expect(media.workspaceDir).not.toBe(state.workspaceDir);
      expect(media.workspaceDir).not.toBe(checkout);
      expect(await fs.readFile(path.resolve(media.workspaceDir!, media.path!), "utf8")).toBe(
        "Please clarify this selection.",
      );
      await expect(fs.stat(path.resolve(checkout, media.path!))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });
});
