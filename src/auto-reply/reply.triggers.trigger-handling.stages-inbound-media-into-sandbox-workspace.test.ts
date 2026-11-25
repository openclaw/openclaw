import fs from "node:fs/promises";
import path, { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readCloneFileMetadata } from "@openclaw/fs-safe/copy";
import { afterEach, beforeEach, describe, expect, it as baseTest, vi } from "vitest";
import { slugifySessionKey } from "../agents/sandbox/shared.js";
import { resolveStagedInputMediaPaths, STAGED_INPUT_MAX_BYTES } from "../media/staged-inputs.js";
import { MEDIA_MAX_BYTES } from "../media/store.js";
import { CONFIG_DIR } from "../utils.js";
import { stageSandboxMedia } from "./reply/stage-sandbox-media.js";
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

type StageParams = Parameters<typeof stageSandboxMedia>[0];
type MediaContexts = Pick<StageParams, "ctx" | "sessionCtx">;
type StageOverrides = Partial<Omit<StageParams, "ctx" | "sessionCtx">>;
const DEFAULT_SESSION_KEY = "agent:main:main";

async function setupSandboxWorkspace(home: string) {
  const cfg = createSandboxMediaStageConfig(home);
  const workspaceDir = join(home, "openclaw");
  const sandboxDir = join(home, "sandboxes", "session");
  await fs.mkdir(sandboxDir, { recursive: true });
  sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue({
    workspaceDir: sandboxDir,
    containerWorkdir: "/work",
  });
  const run = (contexts: MediaContexts, overrides: StageOverrides = {}) =>
    stageSandboxMedia({
      ...contexts,
      cfg,
      workspaceDir,
      sessionKey: DEFAULT_SESSION_KEY,
      ...overrides,
    });
  const stageMedia = async (source: string, overrides?: StageOverrides) => {
    const contexts = createSandboxMediaContexts(source);
    return { ...contexts, result: await run(contexts, overrides) };
  };
  const write = async (relative: string, bytes: string | Buffer = "image-bytes") => {
    const file = join(home, relative);
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return file;
  };
  const inbound = (name: string, bytes?: string | Buffer) =>
    write(`.openclaw/media/inbound/${name}`, bytes);
  return { home, cfg, workspaceDir, sandboxDir, stageMedia, run, write, inbound };
}

const it = baseTest.extend<{ media: Awaited<ReturnType<typeof setupSandboxWorkspace>> }>({
  media: async ({ task }, use) => {
    await withSandboxMediaTempHome(`openclaw-staging-${task.id}-`, async (home) => {
      await use(await setupSandboxWorkspace(home));
    });
  },
});

type StagedMedia = MediaContexts & { result: Awaited<ReturnType<typeof stageSandboxMedia>> };

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

describe("stageSandboxMedia", () => {
  it.for([
    { bytes: 64 * 1024, cloned: false },
    { bytes: 32 * 1024 * 1024, cloned: true },
  ])(
    "copies independent inputs with size-appropriate transfer work: %j",
    async ({ bytes, cloned }, { media: m }) => {
      const original = Buffer.alloc(bytes, 42);
      const source = await m.inbound("independent.bin", original);
      const stagedPath = expectStaged(await m.stageMedia(source), m.sandboxDir);
      const destination = join(m.sandboxDir, stagedPath);
      expect((await fs.readFile(destination)).equals(original)).toBe(true);
      const [sourceMetadata, stagedMetadata] = await readCloneFileMetadata([source, destination]);
      if (sourceMetadata) {
        expect(stagedMetadata?.cloneId === sourceMetadata.cloneId).toBe(cloned);
        expect(stagedMetadata?.ino).not.toBe(sourceMetadata.ino);
      }
      await fs.writeFile(destination, "edited staged input");
      expect((await fs.readFile(source)).equals(original)).toBe(true);
      await fs.writeFile(source, "edited original");
      await expect(fs.readFile(destination, "utf8")).resolves.toBe("edited staged input");
    },
  );

  it("leaves no staged input directory when an owned source is missing", async ({ media: m }) => {
    sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(null);
    const projectFile = await m.write("openclaw/keep.txt", "existing project file");
    const missingPath = await m.inbound("missing.png", "small input");
    await fs.unlink(missingPath);
    const { ctx, sessionCtx } = createSandboxMediaContexts(missingPath);
    const originalMedia = structuredClone(ctx.media);

    const result = await m.run({ ctx, sessionCtx });

    expect(result.staged).toEqual(new Map());
    expect(ctx.media).toEqual(originalMedia);
    expect(sessionCtx.media).toEqual(originalMedia);
    expect(await fs.readdir(m.workspaceDir)).toEqual(["keep.txt"]);
    await expect(fs.readFile(projectFile, "utf8")).resolves.toBe("existing project file");
  });

  it("stages global-session media with the prepared agent owner", async ({ media: m }) => {
    const { ensureSandboxWorkspaceForSession } = await vi.importActual<
      typeof import("../agents/sandbox/context.js")
    >("../agents/sandbox/context.js");
    sandboxMocks.ensureSandboxWorkspaceForSession.mockImplementation(
      ensureSandboxWorkspaceForSession,
    );
    const mediaPath = await m.inbound("global.png");
    const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);
    const workspaceDir = join(m.home, "workspace");

    const result = await m.run(
      { ctx, sessionCtx },
      {
        cfg: { agents: { ownership: "explicit", entries: { main: {}, other: {} } } },
        agentId: "main",
        sessionKey: "global",
        workspaceDir,
      },
    );

    const stagedPath = result.staged.get(0)!;
    expect(ctx.media?.[0]).toMatchObject({ path: stagedPath, workspaceDir, staged: true });
    await expect(fs.readFile(stagedPath, "utf8")).resolves.toBe("image-bytes");
  });

  it("maps a staged upload handle to its exact private input path", async ({ media: m }) => {
    await m.inbound("file_upload.jpg", "jpeg-bytes");
    const { ctx, result } = await m.stageMedia("media://inbound/file_upload.jpg");

    const stagedPath = result.staged.get(0)!;
    expect(resolveStagedInputMediaPaths(ctx.media)).toEqual(
      new Map([
        ["file_upload.jpg", stagedPath],
        ["file_upload", stagedPath],
      ]),
    );
  });

  it("keeps host-staged inbound images available to native vision", async ({ media: m }) => {
    const { workspaceDir } = m;
    sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(null);
    const fileName = "host-photo.png";
    await m.inbound(fileName, "host-image-bytes");
    const existingProjectFile = await m.write(`openclaw/media/inbound/${fileName}`, "project-file");
    const mediaUri = `media://inbound/${fileName}`;
    const blockedPath = await m.write("blocked-host.png", "blocked");
    const { ctx, sessionCtx } = createSandboxMediaContexts(mediaUri);
    ctx.media = [
      { ...ctx.media?.[0], contentType: "image/png" },
      { path: blockedPath, contentType: "image/png" },
    ];
    sessionCtx.media = structuredClone(ctx.media);

    const result = await m.run({ ctx, sessionCtx });

    const stagedPath = ctx.media?.[0]?.path ?? "";
    const stagedRelativePath = path.relative(workspaceDir, stagedPath).replaceAll(path.sep, "/");
    expect(stagedRelativePath).toMatch(
      new RegExp(`^media/inbound/openclaw-staged-[0-9a-f-]+/input-${fileName}$`),
    );
    expect(result.staged).toEqual(new Map([[0, stagedPath]]));
    expect(ctx.media?.[0]).toMatchObject({ path: stagedPath, workspaceDir });
    expect(sessionCtx.media).toEqual(ctx.media);
    await expect(fs.readFile(stagedPath, "utf8")).resolves.toBe("host-image-bytes");
    await expect(fs.readFile(existingProjectFile, "utf8")).resolves.toBe("project-file");
    expect(ctx).not.toHaveProperty("MediaWorkspaceDir");
    expect(ctx.media?.[1]).toMatchObject({ path: blockedPath, contentType: "image/png" });
    expect(ctx.media?.[1]).not.toHaveProperty("workspaceDir");
    expect((await fs.readdir(dirname(stagedPath))).toSorted()).toEqual([
      ".gitignore",
      `input-${fileName}`,
    ]);
  });

  it("blocks remote paths outside the attachment roots before spawning", async ({ media: m }) => {
    const remote = createRemoteContexts("/etc/passwd");
    const result = await m.run(remote);
    expect(processExecMocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expectUnstaged({ ...remote, result }, "/etc/passwd");
  });

  it.for(["file:///", "FILE:///", "FILE:/"])(
    "stages local file URLs with prefix %s",
    async (prefix, { media: m }) => {
      const sourcePath = await m.write(".openclaw/media/cache/café photo.png");
      const sourceUrl = pathToFileURL(sourcePath).href.replace(/^file:\/\/\//u, prefix);
      const stagedPath = expectStaged(await m.stageMedia(sourceUrl), m.sandboxDir);
      await expect(fs.readFile(join(m.sandboxDir, stagedPath), "utf8")).resolves.toBe(
        "image-bytes",
      );
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
    async (allowedIndex, { media: m }) => {
      const blockedIndex = 1 - allowedIndex;
      const allowedPath = await m.inbound("allowed.jpg", "allowed");
      const blockedPath = await m.write("blocked.jpg", "blocked");
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
      const sessionCtx = { media: structuredClone(media) };

      const result = await m.run({ ctx, sessionCtx });

      const stagedPath = expectStaged({ ctx, sessionCtx, result }, m.sandboxDir, allowedIndex);
      expect(stagedPath).toMatch(
        /^media\/inbound\/openclaw-staged-[0-9a-f-]+\/input-allowed\.jpg$/,
      );
      expect(ctx.media[allowedIndex]?.url).toBe(allowedUrl);
      expect(ctx.media[blockedIndex]).toMatchObject({ path: blockedPath });
      expect(ctx.media[blockedIndex]).not.toHaveProperty("workspaceDir");
    },
  );

  it("blocks destination symlink escapes when staging into sandbox workspace", async ({
    media: m,
  }) => {
    const mediaPath = await m.inbound("payload.txt", "PAYLOAD");

    const outsideDir = join(m.home, "outside");
    const outsideInboundDir = join(outsideDir, "inbound");
    await fs.mkdir(outsideInboundDir, { recursive: true });
    const victimPath =
      process.platform === "win32"
        ? join(outsideInboundDir, basename(mediaPath))
        : join(outsideDir, "victim.txt");
    await fs.writeFile(victimPath, "ORIGINAL");

    await fs.symlink(
      outsideDir,
      join(m.sandboxDir, "media"),
      process.platform === "win32" ? "junction" : undefined,
    );
    if (process.platform !== "win32") {
      await fs.symlink(victimPath, join(outsideInboundDir, basename(mediaPath)));
    }

    const { ctx, sessionCtx } = await m.stageMedia(mediaPath);

    await expect(fs.readFile(victimPath, "utf8")).resolves.toBe("ORIGINAL");
    expect(ctx.media?.[0]?.path).toBe(mediaPath);
    expect(sessionCtx.media?.[0]?.path).toBe(mediaPath);
  });

  it.for<
    [
      name: string,
      size: number,
      staged: boolean,
      limits?: { agent?: number; channel?: number; account?: number },
    ]
  >([
    ["above generic store limit", MEDIA_MAX_BYTES + 1, true],
    ["above sandbox limit", STAGED_INPUT_MAX_BYTES + 1, false],
    ["agent limit", 50 * 1024 * 1024 + 1, true, { agent: 51 }],
    ["channel limit", 50 * 1024 * 1024 + 1, true, { channel: 51 }],
    ["account overrides channel", 50 * 1024 * 1024 + 1, true, { channel: 50, account: 51 }],
    ["account rejects above limit", 50 * 1024 * 1024 + 1, false, { channel: 51, account: 50 }],
    ["minimum staging allowance", 10 * 1024 * 1024 + 1, true, { agent: 5 }],
  ])("staging size policy: %s", async ([_name, size, staged, limits], { media: m }) => {
    const { cfg, sandboxDir } = m;
    if (limits) {
      cfg.agents!.defaults!.mediaMaxMb = limits.agent;
      cfg.channels = {
        telegram: {
          mediaMaxMb: limits.channel,
          accounts: { roomy: { mediaMaxMb: limits.account } },
        },
      };
    }
    const mediaPath = await m.inbound("large.bin", "");
    await fs.truncate(mediaPath, size);
    const { ctx, sessionCtx } = createSandboxMediaContexts(mediaPath);
    if (limits) {
      ctx.Surface = "telegram";
      ctx.AccountId = "roomy";
    }
    const warn =
      !limits && !staged ? vi.spyOn(console, "warn").mockImplementation(() => {}) : undefined;
    const result = await m.run({ ctx, sessionCtx });
    if (staged) {
      const stagedPath = expectStaged({ ctx, sessionCtx, result }, sandboxDir);
      expect(stagedPath).toMatch(/^media\/inbound\/openclaw-staged-[0-9a-f-]+\/input-large\.bin$/);
      await expect(fs.stat(join(sandboxDir, stagedPath))).resolves.toMatchObject({ size });
    } else {
      expectUnstaged({ ctx, sessionCtx, result }, mediaPath);
      await expectPathMissing(join(sandboxDir, "media", "inbound"));
      if (!limits) {
        expect(warn).toHaveBeenCalledWith(
          `Inbound media staging skipped for input-large.bin: file exceeds limit of ${STAGED_INPUT_MAX_BYTES} bytes (got ${size})`,
        );
      }
    }
  });
});

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
    media: m,
  }) => {
    sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(null);
    const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/evil$(touch pwned).jpg";
    const { ctx, sessionCtx } = createRemoteContexts(remotePath);

    await m.run({ ctx, sessionCtx });

    expect(processExecMocks.runCommandWithTimeout).not.toHaveBeenCalled();
    await expectPathMissing(join(remoteCacheDir(DEFAULT_SESSION_KEY), basename(remotePath)));
    expect(ctx.media?.[0]).toMatchObject({ path: remotePath, url: remotePath });
    expect(sessionCtx.media).toEqual(ctx.media);
  });

  it("uses a slugged remote cache directory for session keys with path separators", async ({
    media: m,
  }) => {
    sandboxMocks.ensureSandboxWorkspaceForSession.mockResolvedValue(null);
    const sessionKey = "agent:main:explicit:../../escape";
    const remotePath = "/Users/demo/Library/Messages/Attachments/ab/cd/photo.jpg";
    const { ctx, sessionCtx } = createRemoteContexts(remotePath);
    processExecMocks.runCommandWithTimeout.mockRejectedValue(new Error("stop before scp"));

    await m.run({ ctx, sessionCtx }, { sessionKey });

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
    async (forceCache, { media: m }) => {
      const sandboxWorkspace = join(m.home, "sandbox-workspace");
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
      const result = await m.run(
        { ctx, sessionCtx },
        forceCache ? { remoteMediaMode: "cache" } : {},
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
