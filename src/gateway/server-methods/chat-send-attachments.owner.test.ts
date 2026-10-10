import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createCoreCodingTools } from "../../agents/core-coding-tools.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { discardPreparedInboundMedia } from "../chat-attachments.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";

function createWorkspaceOnlyRead(workspaceDir: string) {
  return createCoreCodingTools({
    codingRoot: workspaceDir,
    containmentRoot: workspaceDir,
    includeBaseCodingTools: true,
    shellTools: "disabled",
    workspaceOnly: true,
    readOnly: true,
    applyPatchEnabled: false,
    applyPatchWorkspaceOnly: true,
    execDefaults: {},
    processDefaults: {},
  }).find((tool) => tool.name === "read")!;
}

it.each(["off", "all"] as const)(
  "prepares both owners' global attachments with sandbox %s",
  async (mode) => {
    await withOpenClawTestState({ label: "gateway-media-owner" }, async (state) => {
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
        if (mode === "off") {
          const workspaceDir = state.path(agentId);
          const read = createWorkspaceOnlyRead(workspaceDir);
          const readResult = await read.execute("read-upload", { path: media.path });
          expect(readResult.details).toMatchObject({ kind: "text", content: bytes });
          await expect(
            read.execute("read-original", { path: result.value.offloadedRefs[0]!.path }),
          ).rejects.toThrow(/Path escapes sandbox root/i);
          expect(media.workspaceDir).toBe(workspaceDir);
        }
        expect(media.url).toBe(result.value.offloadedRefs[0]!.mediaRef);
        expect(media.staged).toBe(true);
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

it.each(["managed cwd", "inherited workspace"] as const)(
  "stages chat uploads into the admitted %s rather than the agent base",
  async (binding) => {
    await withOpenClawTestState({ label: "chat-worktree-attachment" }, async (state) => {
      const workspaceDir = state.path("worktree");
      await fs.mkdir(workspaceDir);
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: { workspace: state.workspaceDir } },
          defaults: { skipBootstrap: true, sandbox: { mode: "off" as const } },
        },
      };
      await state.writeConfig(cfg);
      const sessionKey = "agent:main:worktree";
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "attachment-worktree-session",
          updatedAt: Date.now(),
          ...(binding === "managed cwd"
            ? { spawnedCwd: workspaceDir }
            : {
                spawnedBy: "agent:main:main",
                spawnedWorkspaceDir: workspaceDir,
                spawnedCwd: state.path("different-cwd"),
              }),
        },
      );
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const respond = vi.fn();
      const runId = "worktree-attachment";
      const bytes = "worktree attachment contents";
      const setup = await prepareAndAdmitChatSend({
        client: null,
        context,
        respond,
        params: {
          agentId: "main",
          sessionKey,
          message: "read the file",
          idempotencyKey: runId,
          attachments: [
            {
              fileName: "notes.txt",
              mimeType: "text/plain",
              content: Buffer.from(bytes).toString("base64"),
            },
          ],
        },
      });
      if (!setup) {
        throw new Error("worktree chat admission failed");
      }
      let prepared: Awaited<ReturnType<typeof prepareChatSendAttachments>> | undefined;
      try {
        prepared = await prepareChatSendAttachments({ ...setup, context, respond });
        expect(respond).not.toHaveBeenCalled();
        if (!prepared.ok) {
          throw new Error("worktree attachment preparation failed");
        }
        const media = prepared.value.mediaPathOffloads[0]!;
        const read = createWorkspaceOnlyRead(workspaceDir);
        const readResult = await read.execute("read-worktree-upload", { path: media.path });
        expect(readResult.details).toMatchObject({ kind: "text", content: bytes });
        expect(media.workspaceDir).toBe(workspaceDir);
        expect(media.url).toBe(prepared.value.offloadedRefs[0]!.mediaRef);
        await expect(
          fs.access(path.join(state.workspaceDir, "media", "inbound")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        setup.admission.cleanupAdmittedRun();
        clearAgentRunContext(runId, setup.admission.lifecycleGeneration);
        setup.session.releaseSessionTarget();
        if (prepared?.ok) {
          await discardPreparedInboundMedia(prepared.value.offloadedRefs);
        }
      }
    });
  },
);
