/** Post-seed inbound media staging through the SSH sandbox's remote filesystem owner. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSandbox } from "../agents/sandbox/fs-bridge.test-helpers.js";
import { createRemoteShellSandboxFsBridge } from "../agents/sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "../agents/sandbox/remote-fs-bridge.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareChatSendAttachments } from "../gateway/server-methods/chat-send-attachments.js";
import { normalizeChatSendRequest } from "../gateway/server-methods/chat-send-request.js";
import {
  createMediaAttachmentCache,
  normalizeMediaAttachments,
} from "../media-understanding/runner.attachments.js";
import type * as ProcessExec from "../process/exec.js";
import { stageSandboxMedia } from "./reply/stage-sandbox-media.js";
import {
  createSandboxMediaContexts,
  withSandboxMediaTempHome,
} from "./stage-sandbox-media.test-harness.js";

const sandboxMocks = vi.hoisted(() => ({
  resolveSandboxContext: vi.fn(),
  ensureSandboxWorkspaceForSession: vi.fn(),
}));
vi.mock("../agents/sandbox.js", () => sandboxMocks);
vi.mock("../agents/sandbox/context.js", () => sandboxMocks);
const remoteSourceMocks = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn(),
  resolveChannelRemoteInboundAttachmentRoots: vi.fn(() => ["/remote/inbound"]),
}));
vi.mock("../media/channel-inbound-roots.js", () => ({
  resolveChannelRemoteInboundAttachmentRoots:
    remoteSourceMocks.resolveChannelRemoteInboundAttachmentRoots,
}));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessExec>()),
  runCommandWithTimeout: remoteSourceMocks.runCommandWithTimeout,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("SSH post-seed inbound staging", () => {
  it.each([
    { workspaceAccess: "rw", sourceKind: "local" },
    { workspaceAccess: "none", sourceKind: "local" },
    { workspaceAccess: "ro", sourceKind: "local" },
    { workspaceAccess: "rw", sourceKind: "scp" },
    { workspaceAccess: "rw", sourceKind: "upload" },
  ] as const)(
    "keeps $sourceKind input readable with workspaceAccess=$workspaceAccess",
    async ({ workspaceAccess, sourceKind }) => {
      await withSandboxMediaTempHome("openclaw-ssh-media-", async (home) => {
        const localWorkspace = path.join(home, "gateway-workspace");
        const remoteWorkspace = path.join(await fs.realpath(tempDirs.make("ssh-media-")), "remote");
        await fs.mkdir(localWorkspace, { recursive: true });
        await fs.mkdir(remoteWorkspace);
        // Model the already-seeded remote workspace independently from Gateway storage.
        // The real remote bridge scripts, source policy and staging owner run below.
        await fs.writeFile(path.join(remoteWorkspace, "seeded.txt"), "first turn");
        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir: localWorkspace,
            agentWorkspaceDir: localWorkspace,
            workspaceAccess,
            containerWorkdir: remoteWorkspace,
          }),
          runtime: {
            remoteWorkspaceDir: remoteWorkspace,
            remoteAgentWorkspaceDir: remoteWorkspace,
            runRemoteShellScript: createLocalRemoteShellScriptRunner(),
          },
        });
        sandboxMocks.resolveSandboxContext.mockReset().mockResolvedValue({
          workspaceDir: localWorkspace,
          fsBridge: bridge,
        });
        sandboxMocks.ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue({
          workspaceDir: localWorkspace,
        });

        const inboundDir = path.join(home, ".openclaw", "media", "inbound");
        await fs.mkdir(inboundDir, { recursive: true });
        const source =
          sourceKind === "scp" ? "/remote/inbound/photo.txt" : path.join(inboundDir, "photo.txt");
        const payload = Buffer.from("second-turn document");
        let downloadedPath: string | undefined;
        if (sourceKind === "scp") {
          remoteSourceMocks.runCommandWithTimeout.mockReset().mockImplementation(async (args) => {
            downloadedPath = args.at(-1);
            await fs.writeFile(downloadedPath!, payload);
            return { code: 0, stdout: "", stderr: "" };
          });
        } else {
          await fs.writeFile(source, payload);
        }
        const { ctx, sessionCtx } = createSandboxMediaContexts(source);
        if (sourceKind === "scp") {
          ctx.MediaRemoteHost = "test@source-host";
          sessionCtx.MediaRemoteHost = ctx.MediaRemoteHost;
        }
        const cfg: OpenClawConfig = {
          agents: { defaults: { workspace: localWorkspace, sandbox: { backend: "ssh" } } },
        };
        const skillsSnapshot =
          workspaceAccess === "rw"
            ? {
                prompt: "",
                skills: [],
                librarySelections: [
                  {
                    skillId: "00000000-0000-0000-0000-000000000001",
                    revision: "0".repeat(64),
                    name: "private-proof",
                    ownerProfileId: "private-profile",
                  },
                ],
              }
            : undefined;

        if (sourceKind === "upload") {
          const request = await normalizeChatSendRequest({
            client: null,
            params: {
              sessionKey: "agent:main:chat",
              message: "Read this document",
              idempotencyKey: "ssh-upload",
              attachments: [
                {
                  fileName: "photo.txt",
                  mimeType: "text/plain",
                  content: payload.toString("base64"),
                },
              ],
            },
          });
          if (!request.ok) {
            throw new Error(request.error);
          }
          const controller = new AbortController();
          const prepared = await prepareChatSendAttachments({
            request: request.value,
            session: {
              cfg,
              sessionKey: "agent:main:chat",
              agentId: "main",
              resolvedSessionModel: { provider: "fixture", model: "fixture" },
              clientRunId: "ssh-upload",
            },
            admission: {
              activeRunAbort: { controller },
              assertWorkAdmissionCurrent: () => controller.signal.throwIfAborted(),
              cleanupAdmittedRun() {},
            },
            context: {},
            respond: vi.fn(),
          } as unknown as Parameters<typeof prepareChatSendAttachments>[0]);
          expect(prepared.ok).toBe(true);
          if (!prepared.ok) {
            throw new Error("attachment preparation failed");
          }
          ctx.media = prepared.value.mediaPathOffloads;
          sessionCtx.media = ctx.media;
        } else {
          await stageSandboxMedia({
            ctx,
            sessionCtx,
            cfg,
            sessionKey: "agent:main:chat",
            workspaceDir: localWorkspace,
            skillsSnapshot,
          });
        }

        expect(await fs.readFile(path.join(remoteWorkspace, "seeded.txt"), "utf8")).toBe(
          "first turn",
        );
        if (workspaceAccess === "ro") {
          expect(ctx.media?.[0]?.path).toBe(source);
          expect(await fs.readdir(remoteWorkspace)).toEqual(["seeded.txt"]);
          expect(await fs.readdir(localWorkspace)).toEqual([]);
          return;
        }

        const staged = ctx.media?.[0]?.path;
        expect(staged).toMatch(/^media\/inbound\/openclaw-staged-[\da-f-]+\/input-.*\.txt$/u);
        expect(sessionCtx.media?.[0]?.path).toBe(staged);
        expect(await bridge.readFile({ filePath: staged! })).toEqual(payload);
        expect(sha256(await fs.readFile(path.join(remoteWorkspace, staged!)))).toBe(
          sha256(payload),
        );
        expect(
          await fs.readFile(
            path.join(remoteWorkspace, path.dirname(staged!), ".gitignore"),
            "utf8",
          ),
        ).toContain("Raw task inputs remain private");
        expect(await fs.readdir(localWorkspace)).toEqual([]);
        const cache = createMediaAttachmentCache(normalizeMediaAttachments(ctx), {
          localPathRoots: [inboundDir, localWorkspace],
          includeDefaultLocalPathRoots: false,
        });
        try {
          const original = await cache.getBuffer({
            attachmentIndex: 0,
            maxBytes: 1024,
            timeoutMs: 1000,
          });
          expect(original.buffer).toEqual(payload);
        } finally {
          await cache.cleanup();
        }
        if (downloadedPath) {
          await expect(fs.stat(downloadedPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );
});
