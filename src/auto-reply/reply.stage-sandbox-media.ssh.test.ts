import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createSandbox } from "../agents/sandbox/fs-bridge.test-helpers.js";
import { createRemoteShellSandboxFsBridge } from "../agents/sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "../agents/sandbox/remote-fs-bridge.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  attachmentParams,
  prepareAttachmentFixture,
} from "../gateway/server-methods/chat-send-attachments.test-support.js";
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
vi.mock("../infra/device-identity-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-identity-async.js")>()),
  loadChatRequestIdentityKeyAsync: vi.fn(async () => Buffer.alloc(32, 7)),
}));
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
      const readRemote = (file: string) => fs.readFile(path.join(remoteWorkspace, file), "utf8");
      await fs.mkdir(localWorkspace, { recursive: true });
      await fs.mkdir(remoteWorkspace);
      // Seed the remote workspace independently from Gateway storage.
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

      if (sourceKind === "upload") {
        const { result: prepared } = await prepareAttachmentFixture({
          params: attachmentParams("ssh-upload", "photo.txt", payload, {
            sessionKey: "agent:main:chat",
            message: "Read this document",
          }),
          session: { cfg },
          context: {},
        });
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
        });
      }

      expect(await readRemote("seeded.txt")).toBe("first turn");
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
      expect(await fs.readFile(path.join(remoteWorkspace, staged!))).toEqual(payload);
      expect(await readRemote(path.join(path.dirname(staged!), ".gitignore"))).toContain(
        "Raw task inputs remain private",
      );
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
