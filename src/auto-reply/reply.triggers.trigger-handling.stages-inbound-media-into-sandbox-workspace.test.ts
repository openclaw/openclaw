import fs from "node:fs/promises";
import path, { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it as baseTest, vi } from "vitest";
import { slugifySessionKey } from "../agents/sandbox/shared.js";
import { resolveStagedInputMediaPaths } from "../media/staged-inputs.js";
import { MEDIA_MAX_BYTES } from "../media/store.js";
import { CONFIG_DIR } from "../utils.js";
import { SANDBOX_MEDIA_MAX_BYTES, stageSandboxMedia } from "./reply/stage-sandbox-media.js";
import {
  createSandboxMediaContexts,
  createSandboxWorkspacePreparation,
  createSandboxMediaStageConfig,
  withSandboxMediaTempHome,
} from "./stage-sandbox-media.test-harness.js";

const sandboxMocks = vi.hoisted(() => ({
  ensureSandboxWorkspaceForSession: vi.fn(),
  assertSandboxPath: vi.fn(),
}));
const processExecMocks = vi.hoisted(() => ({ runCommandWithTimeout: vi.fn() }));
const mediaRootMocks = vi.hoisted(() => ({
  resolveChannelRemoteInboundAttachmentRoots: vi.fn(),
}));

// mock-isolation: File-policy cases supply fixture workspaces and opt into real preparation explicitly.
vi.mock("../agents/sandbox/context.js", () => ({
  ...sandboxMocks,
  prepareSandboxWorkspaceForSession: async (...args: unknown[]) =>
    createSandboxWorkspacePreparation(await sandboxMocks.ensureSandboxWorkspaceForSession(...args)),
}));
vi.mock("../agents/sandbox-paths.js", () => ({
  assertSandboxPath: sandboxMocks.assertSandboxPath,
}));
vi.mock("../media/channel-inbound-roots.js", () => mediaRootMocks);
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: processExecMocks.runCommandWithTimeout,
}));

beforeEach(() => {
  sandboxMocks.ensureSandboxWorkspaceForSession.mockReset();
  sandboxMocks.assertSandboxPath.mockReset().mockResolvedValue({ resolved: "", relative: "" });
  processExecMocks.runCommandWithTimeout.mockReset();
  mediaRootMocks.resolveChannelRemoteInboundAttachmentRoots
    .mockReset()
    .mockReturnValue(["/Users/demo/Library/Messages/Attachments"]);
});

afterEach(() => vi.restoreAllMocks());

async function setupSandboxWorkspace(home: string) {
  const cfg = createSandboxMediaStageConfig(home);
  const workspaceDir = join(home, "openclaw");
  const sandboxDir = join(home, "sandboxes", "session");
  await fs.mkdir(sandboxDir, { recursive: true });
  sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue({
    workspaceDir: sandboxDir,
    containerWorkdir: "/work",
  });
  const stageMedia = async (source: string) => {
    const contexts = createSandboxMediaContexts(source);
    return { ...contexts, result: await stage(contexts, cfg, workspaceDir) };
  };
  return { home, cfg, workspaceDir, sandboxDir, stageMedia };
}

const it = baseTest.extend<{ media: Awaited<ReturnType<typeof setupSandboxWorkspace>> }>({
  media: async ({ task }, use) => {
    await withSandboxMediaTempHome(`openclaw-staging-${task.id}-`, async (home) => {
      await use(await setupSandboxWorkspace(home));
    });
  },
});

type StagedMedia = Awaited<
  ReturnType<Awaited<ReturnType<typeof setupSandboxWorkspace>>["stageMedia"]>
>;

function expectStaged({ ctx, sessionCtx, result }: StagedMedia, workspaceDir: string, index = 0) {
  const stagedPath = result.staged.get(index)!;
  expect(stagedPath).toMatch(/^media\/inbound\/openclaw-staged-[0-9a-f-]+\/input-/);
  expect(result.staged).toEqual(new Map([[index, stagedPath]]));
  expect(ctx.media?.[index]).toMatchObject({ path: stagedPath, workspaceDir });
  expect(sessionCtx.media).toEqual(ctx.media);
  return stagedPath;
}

function expectUnstaged({ ctx, sessionCtx, result }: StagedMedia, source: string) {
  expect(result.staged).toEqual(new Map());
  expect(ctx.media?.[0]?.path).toBe(source);
  expect(ctx.media?.[0]?.workspaceDir).toBeUndefined();
  expect(sessionCtx.media).toEqual(ctx.media);
}

async function writeInboundMedia(
  home: string,
  fileName: string,
  payload: string | Buffer,
): Promise<string> {
  const inboundDir = join(home, ".openclaw", "media", "inbound");
  await fs.mkdir(inboundDir, { recursive: true });
  const mediaPath = join(inboundDir, fileName);
  await fs.writeFile(mediaPath, payload);
  return mediaPath;
}

function stage(
  contexts: Pick<Parameters<typeof stageSandboxMedia>[0], "ctx" | "sessionCtx">,
  cfg: Parameters<typeof stageSandboxMedia>[0]["cfg"],
  workspaceDir: string,
) {
  return stageSandboxMedia({ ...contexts, cfg, workspaceDir, sessionKey: "agent:main:main" });
}

describe("stageSandboxMedia", () => {
  it("leaves no staged input directory when an owned source is missing", async ({
    media: { home, cfg, workspaceDir },
  }) => {
    sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(null);
    await fs.mkdir(workspaceDir, { recursive: true });
    const projectFile = join(workspaceDir, "keep.txt");
    await fs.writeFile(projectFile, "existing project file");
    const missingPath = await writeInboundMedia(home, "missing.png", "small input");
    await fs.unlink(missingPath);
    const { ctx, sessionCtx } = createSandboxMediaContexts(missingPath);
    const originalMedia = structuredClone(ctx.media);

    const result = await stage({ ctx, sessionCtx }, cfg, workspaceDir);

    expect(result.staged).toEqual(new Map());
    expect(ctx.media).toEqual(originalMedia);
    expect(sessionCtx.media).toEqual(originalMedia);
    expect(await fs.readdir(workspaceDir)).toEqual(["keep.txt"]);
    await expect(fs.readFile(projectFile, "utf8")).resolves.toBe("existing project file");
  });

  it("stages global-session media with the prepared agent owner", async ({ media: { home } }) => {
    const { ensureSandboxWorkspaceForSession } = await vi.importActual<
      typeof import("../agents/sandbox/context.js")
    >("../agents/sandbox/context.js");
    sandboxMocks.ensureSandboxWorkspaceForSession.mockImplementation(
      ensureSandboxWorkspaceForSession,
    );
    const mediaPath = await writeInboundMedia(home, "global.png", "image-bytes");
    const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);
    const workspaceDir = join(home, "workspace");

    const result = await stageSandboxMedia({
      ctx,
      sessionCtx,
      cfg: { agents: { ownership: "explicit", entries: { main: {}, other: {} } } },
      agentId: "main",
      sessionKey: "global",
      workspaceDir,
    });

    const stagedPath = result.staged.get(0)!;
    expect(ctx.media?.[0]).toMatchObject({ path: stagedPath, workspaceDir, staged: true });
    await expect(fs.readFile(stagedPath, "utf8")).resolves.toBe("image-bytes");
  });

  it("maps a staged upload handle to its exact private input path", async ({
    media: { home, stageMedia },
  }) => {
    await writeInboundMedia(home, "file_upload.jpg", "jpeg-bytes");
    const { ctx, result } = await stageMedia("media://inbound/file_upload.jpg");

    const stagedPath = result.staged.get(0)!;
    expect(resolveStagedInputMediaPaths(ctx.media)).toEqual(
      new Map([
        ["file_upload.jpg", stagedPath],
        ["file_upload", stagedPath],
      ]),
    );
  });

  it("keeps host-staged inbound images available to native vision", async ({
    media: { home, cfg, workspaceDir },
  }) => {
    sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(null);
    const fileName = "host-photo.png";
    await writeInboundMedia(home, fileName, "host-image-bytes");
    const existingProjectFile = join(workspaceDir, "media", "inbound", fileName);
    await fs.mkdir(dirname(existingProjectFile), { recursive: true });
    await fs.writeFile(existingProjectFile, "project-file");
    const mediaUri = `media://inbound/${fileName}`;
    const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
    ctx.media = [{ ...ctx.media?.[0], contentType: "image/png" }];
    sessionCtx.media = ctx.media;

    const result = await stage({ ctx, sessionCtx }, cfg, workspaceDir);

    const stagedPath = ctx.media?.[0]?.path ?? "";
    const stagedRelativePath = path.relative(workspaceDir, stagedPath).replaceAll(path.sep, "/");
    expect(stagedRelativePath).toMatch(
      new RegExp(`^media/inbound/openclaw-staged-[0-9a-f-]+/input-${fileName}$`),
    );
    expect(result.staged.get(0)).toBe(stagedPath);
    expect(ctx.media?.[0]).toMatchObject({ path: stagedPath, workspaceDir });
    expect(sessionCtx.media).toEqual(ctx.media);
    await expect(fs.readFile(stagedPath, "utf8")).resolves.toBe("host-image-bytes");
    await expect(fs.readFile(existingProjectFile, "utf8")).resolves.toBe("project-file");

    const blockedPath = join(home, "blocked-host.png");
    await fs.writeFile(blockedPath, "blocked");
    const partialCtx = {
      media: [
        { path: mediaUri, contentType: "image/png" },
        { path: blockedPath, contentType: "image/png" },
      ],
    };
    const partialSessionCtx = { media: structuredClone(partialCtx.media) };
    const partialResult = await stage(
      { ctx: partialCtx, sessionCtx: partialSessionCtx },
      cfg,
      workspaceDir,
    );
    expect([...partialResult.staged.keys()]).toEqual([0]);
    expect(partialResult.staged.get(0)).toBe(partialCtx.media[0]?.path);
    expect(partialCtx).not.toHaveProperty("MediaWorkspaceDir");
    expect(partialCtx.media[0]).toMatchObject({ workspaceDir });
    expect(partialCtx.media[1]).toMatchObject({ path: blockedPath, contentType: "image/png" });
    expect(partialCtx.media[1]).not.toHaveProperty("workspaceDir");
    expect(partialSessionCtx.media).toEqual(partialCtx.media);
    expect((await fs.readdir(dirname(partialResult.staged.get(0)!))).toSorted()).toEqual([
      ".gitignore",
      `input-${fileName}`,
    ]);
  });

  it("blocks remote paths outside the attachment roots before spawning", async ({
    media: { cfg, workspaceDir },
  }) => {
    const remote = createSandboxMediaContexts("/etc/passwd");
    for (const context of [remote.ctx, remote.sessionCtx]) {
      context.Provider = "imessage";
      context.MediaRemoteHost = "user@gateway-host";
    }
    const result = await stage(remote, cfg, workspaceDir);
    expect(processExecMocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expectUnstaged({ ...remote, result }, "/etc/passwd");
  });

  it.for(["file:///", "FILE:///", "FILE:/"])(
    "stages local file URLs with prefix %s",
    async (prefix, { media: { home, stageMedia, sandboxDir } }) => {
      const sourceDir = join(home, ".openclaw", "media", "cache");
      const fileName = "café photo.png";
      const sourcePath = join(sourceDir, fileName);
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(sourcePath, "image-bytes");
      const sourceUrl = pathToFileURL(sourcePath).href.replace(/^file:\/\/\//u, prefix);
      const stagedPath = expectStaged(await stageMedia(sourceUrl), sandboxDir);
      await expect(fs.readFile(join(sandboxDir, stagedPath), "utf8")).resolves.toBe("image-bytes");
    },
  );

  it.for([
    "FILE://server/share/photo.png",
    "FILE:///C:/media%2Fphoto.png",
    "FILE:///C:/media%5Cphoto.png",
    "FILE:/C:/media%2Fphoto.png",
    "FILE:/C:/media%5Cphoto.png",
    "FILE:////server/share/photo.png",
  ])(
    "rejects unsafe uppercase file URL before staging: %s",
    async (sourceUrl, { media: { stageMedia } }) => {
      expectUnstaged(await stageMedia(sourceUrl), sourceUrl);
    },
  );

  it.for([1, 0])(
    "updates facts positionally with staged slot %s",
    async (allowedIndex, { media: { home, cfg, workspaceDir, sandboxDir } }) => {
      const blockedIndex = 1 - allowedIndex;
      const allowedPath = await writeInboundMedia(home, "allowed.jpg", "allowed");
      const blockedPath = join(home, "blocked.jpg");
      await fs.writeFile(blockedPath, "blocked");
      const allowedUrl = "https://cdn.example/allowed.jpg";
      const media = [allowedPath, blockedPath].map((pathValue, index) => ({
        path: pathValue,
        url: index === 0 ? allowedUrl : undefined,
        contentType: "image/jpeg",
      }));
      if (allowedIndex === 1) {
        media.reverse();
      }
      const ctx = { media };
      const sessionCtx = {
        media: structuredClone(media),
      };

      const result = await stage({ ctx, sessionCtx }, cfg, workspaceDir);

      const stagedPath = expectStaged({ ctx, sessionCtx, result }, sandboxDir, allowedIndex);
      expect(stagedPath).toMatch(
        /^media\/inbound\/openclaw-staged-[0-9a-f-]+\/input-allowed\.jpg$/,
      );
      expect(ctx.media[allowedIndex]?.url).toBe(allowedUrl);
      expect(ctx.media[blockedIndex]).toMatchObject({ path: blockedPath });
      expect(ctx.media[blockedIndex]).not.toHaveProperty("workspaceDir");
    },
  );

  it("blocks destination symlink escapes when staging into sandbox workspace", async ({
    media: { home, stageMedia, sandboxDir },
  }) => {
    const mediaPath = await writeInboundMedia(home, "payload.txt", "PAYLOAD");

    const outsideDir = join(home, "outside");
    const outsideInboundDir = join(outsideDir, "inbound");
    await fs.mkdir(outsideInboundDir, { recursive: true });
    const victimPath =
      process.platform === "win32"
        ? join(outsideInboundDir, basename(mediaPath))
        : join(outsideDir, "victim.txt");
    await fs.writeFile(victimPath, "ORIGINAL");

    await fs.symlink(
      outsideDir,
      join(sandboxDir, "media"),
      process.platform === "win32" ? "junction" : undefined,
    );
    if (process.platform !== "win32") {
      await fs.symlink(victimPath, join(outsideInboundDir, basename(mediaPath)));
    }

    const { ctx, sessionCtx } = await stageMedia(mediaPath);

    await expect(fs.readFile(victimPath, "utf8")).resolves.toBe("ORIGINAL");
    expect(ctx.media?.[0]?.path).toBe(mediaPath);
    expect(sessionCtx.media?.[0]?.path).toBe(mediaPath);
  });

  it("stages media above the generic media-store limit", async ({
    media: { home, stageMedia, sandboxDir },
  }) => {
    const mediaPath = await writeInboundMedia(
      home,
      "large.bin",
      Buffer.alloc(MEDIA_MAX_BYTES + 1, 0x41),
    );
    const stagedPath = expectStaged(await stageMedia(mediaPath), sandboxDir);
    expect(stagedPath).toMatch(/^media\/inbound\/openclaw-staged-[0-9a-f-]+\/input-large\.bin$/);
    await expect(fs.stat(join(sandboxDir, stagedPath))).resolves.toMatchObject({
      size: MEDIA_MAX_BYTES + 1,
    });
  });

  it("warns and keeps original media paths above the sandbox staging limit", async ({
    media: { home, stageMedia, sandboxDir },
  }) => {
    const stagingMaxBytes = SANDBOX_MEDIA_MAX_BYTES;
    const mediaPath = await writeInboundMedia(home, "oversized.bin", "");
    await fs.truncate(mediaPath, stagingMaxBytes + 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expectUnstaged(await stageMedia(mediaPath), mediaPath);
    const inboundDir = join(sandboxDir, "media", "inbound");
    await expect(fs.stat(inboundDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(warn).toHaveBeenCalledWith(
      `Inbound media staging skipped for input-oversized.bin: file exceeds limit of ${stagingMaxBytes} bytes (got ${stagingMaxBytes + 1})`,
    );
  });

  it.for([
    { agentMb: 51, channelMb: undefined, accountMb: undefined, fileMb: 50, staged: true },
    { agentMb: undefined, channelMb: 51, accountMb: undefined, fileMb: 50, staged: true },
    { agentMb: undefined, channelMb: 50, accountMb: 51, fileMb: 50, staged: true },
    { agentMb: undefined, channelMb: 51, accountMb: 50, fileMb: 50, staged: false },
    { agentMb: 5, channelMb: undefined, accountMb: undefined, fileMb: 10, staged: true },
  ])(
    "stages admitted media with limits %j",
    async (
      { agentMb, channelMb, accountMb, fileMb, staged },
      { media: { home, cfg, workspaceDir, sandboxDir } },
    ) => {
      cfg.agents!.defaults!.mediaMaxMb = agentMb;
      cfg.channels = {
        telegram: {
          mediaMaxMb: channelMb,
          accounts: { roomy: { mediaMaxMb: accountMb } },
        },
      };
      const mediaPath = await writeInboundMedia(home, "large.bin", "");
      const size = fileMb * 1024 * 1024 + 1;
      await fs.truncate(mediaPath, size);
      const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);
      ctx.Surface = "telegram";
      ctx.AccountId = "roomy";
      const result = await stage({ ctx, sessionCtx }, cfg, workspaceDir);

      expect(result.staged.size).toBe(staged ? 1 : 0);
      if (staged) {
        const stagedPath = expectStaged({ ctx, sessionCtx, result }, sandboxDir);
        await expect(fs.stat(join(sandboxDir, stagedPath))).resolves.toMatchObject({ size });
      } else {
        expect(ctx.media?.[0]?.path).toBe(mediaPath);
        await expect(fs.stat(join(sandboxDir, "media", "inbound"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    },
  );
});

const DEFAULT_SESSION_KEY = "agent:main:main";
const remoteCacheDir = (key: string) =>
  join(CONFIG_DIR, "media", "remote-cache", slugifySessionKey(key));

function createRemoteContexts(remotePath: string) {
  const { ctx, sessionCtx } = createSandboxMediaContexts(remotePath);
  const remote = { Provider: "imessage", MediaRemoteHost: "user@gateway-host" };
  Object.assign(ctx, remote);
  Object.assign(sessionCtx, remote);
  return { ctx, sessionCtx };
}

const expectPathMissing = (targetPath: string) =>
  expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });

function mockDownload() {
  processExecMocks.runCommandWithTimeout.mockImplementation(async (argv: string[]) => {
    const localPath = argv.at(-1);
    if (!localPath) {
      throw new Error("missing scp destination");
    }
    await fs.writeFile(localPath, "staged-image-bytes");
    return { code: 0, stdout: "", stderr: "" };
  });
}

function stageRemote(
  contexts: ReturnType<typeof createRemoteContexts>,
  params: Omit<Parameters<typeof stageSandboxMedia>[0], "ctx" | "sessionCtx">,
) {
  return stageSandboxMedia({ sessionKey: DEFAULT_SESSION_KEY, ...contexts, ...params });
}

async function expectCached(
  result: Awaited<ReturnType<typeof stageSandboxMedia>>,
  ctx: ReturnType<typeof createRemoteContexts>["ctx"],
  sessionKey: string,
) {
  const stagedPath = result.staged.get(0)!;
  const cacheDir = remoteCacheDir(sessionKey);
  expect(stagedPath).toContain(cacheDir);
  expect(basename(stagedPath)).toBe("input-photo.jpg");
  expect(ctx.media?.[0]).toMatchObject({ path: stagedPath, workspaceDir: cacheDir });
  expect(await fs.readFile(stagedPath, "utf8")).toBe("staged-image-bytes");
  await fs.rm(cacheDir, { recursive: true, force: true });
  return stagedPath;
}

describe("stageSandboxMedia scp remote paths", () => {
  it("rejects remote attachment filenames with shell metacharacters before spawning scp", async ({
    media: { cfg, workspaceDir },
  }) => {
    sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(null);
    const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/evil$(touch pwned).jpg";
    const { ctx, sessionCtx } = createRemoteContexts(remotePath);

    await stageRemote({ ctx, sessionCtx }, { cfg, workspaceDir });

    expect(processExecMocks.runCommandWithTimeout).not.toHaveBeenCalled();
    await expectPathMissing(join(remoteCacheDir(DEFAULT_SESSION_KEY), basename(remotePath)));
    expect(ctx.media?.[0]).toMatchObject({ path: remotePath, url: remotePath });
    expect(sessionCtx.media).toEqual(ctx.media);
  });

  it("uses a slugged remote cache directory for session keys with path separators", async ({
    media: { cfg, workspaceDir },
  }) => {
    sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(null);
    const sessionKey = "agent:main:explicit:../../escape";
    const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const { ctx, sessionCtx } = createRemoteContexts(remotePath);
    processExecMocks.runCommandWithTimeout.mockRejectedValue(new Error("stop before scp"));

    await stageRemote({ ctx, sessionCtx }, { cfg, sessionKey, workspaceDir });

    const command = processExecMocks.runCommandWithTimeout.mock.calls[0]?.[0];
    expect(command).toEqual(expect.arrayContaining(["scp"]));
    const cacheDir = remoteCacheDir(sessionKey);
    try {
      expect((await fs.stat(cacheDir)).isDirectory()).toBe(true);
      await expectPathMissing(join(CONFIG_DIR, "escape"));
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it.for([false, true])(
    "rewrites remote media into an absolute cache path (force cache=%s)",
    async (forceCache, { media: { home, cfg, workspaceDir } }) => {
      const sandboxWorkspace = join(home, "sandbox-workspace");
      sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(
        forceCache ? { workspaceDir: sandboxWorkspace, workspaceAccess: "workspace-write" } : null,
      );
      const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
      const { ctx, sessionCtx } = createRemoteContexts(remotePath);
      ctx.media = [
        forceCache
          ? { path: remotePath }
          : {
              path: remotePath,
              url: process.platform === "win32" ? remotePath : pathToFileURL(remotePath).href,
            },
      ];
      sessionCtx.media = ctx.media;
      mockDownload();
      const result = await stageRemote(
        { ctx, sessionCtx },
        {
          cfg,
          workspaceDir,
          ...(forceCache ? { remoteMediaMode: "cache" as const } : {}),
        },
      );
      const stagedPath = await expectCached(result, ctx, DEFAULT_SESSION_KEY);
      expect(sessionCtx.media).toEqual(ctx.media);
      if (forceCache) {
        await expectPathMissing(join(sandboxWorkspace, "media", "inbound", basename(remotePath)));
      } else {
        expect(ctx.media?.[0]?.url).toBe(stagedPath);
      }
    },
  );
});
