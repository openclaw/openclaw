import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getMediaDir, saveMediaBuffer } from "../../media/store.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry } from "../session-utils.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { buildAssistantReplyContent } from "./chat-assistant-content.js";
import {
  captureWebchatReplyMediaScope,
  getWebchatReplyMediaLocalRoots,
  normalizeWebchatReplyMediaPathsForDisplay,
} from "./chat-reply-media.js";
import { seedWebchatReplyMediaScope } from "./chat-reply-media.test-support.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const TEST_SESSION_KEY = "agent:main:webchat:direct:user";

describe("WebChat reply media workspace ownership", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-webchat-reply-media-",
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await drainGlobalSingletonLifecycleState();
    await testState.cleanup();
  });

  function createMediaTestContext(params: { allowRead: boolean }) {
    const workspaceDir = testState.statePath("workspace");
    const cfg: OpenClawConfig = {
      tools: params.allowRead ? { allow: ["read"] } : { fs: { workspaceOnly: true } },
      agents: {
        entries: {
          main: {
            agentDir: testState.statePath("agents", "main", "agent"),
            workspace: workspaceDir,
          },
        },
      },
    };
    return { cfg, workspaceDir };
  }

  async function createAudioFile(audioPath: string): Promise<void> {
    await fs.mkdir(path.dirname(audioPath), { recursive: true });
    await fs.writeFile(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  }

  function requireString(value: string | undefined, label: string): string {
    if (!value) {
      throw new Error(`expected ${label}`);
    }
    return value;
  }

  function dataImageUrl(): string {
    return `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
  }

  it("stops staging before file content I/O when the workspace changes", async () => {
    const { cfg } = createMediaTestContext({ allowRead: true });
    cfg.tools = { ...cfg.tools, fs: { workspaceOnly: true } };
    const selected = testState.statePath("worktrees", "selected");
    const source = path.join(selected, "chart.png");
    await fs.mkdir(selected, { recursive: true });
    await fs.writeFile(source, PNG_BYTES);
    const target = {
      sessionKey: TEST_SESSION_KEY,
      sessionId: "changing-media-policy",
      agentId: "main",
      storePath: loadSessionEntry(TEST_SESSION_KEY, { agentId: "main" }).storePath,
    };
    const entry: SessionEntry = {
      sessionId: target.sessionId,
      lifecycleRevision: "initial",
      permissionMode: "full",
      sessionRoot: selected,
      updatedAt: 1,
    };
    await replaceSessionEntry(target, entry);
    const scope = captureWebchatReplyMediaScope({
      cfg,
      agentId: "main",
      sessionKey: TEST_SESSION_KEY,
      sessionLoadOptions: { agentId: "main" },
    });
    const opened = createDeferred();
    const release = createDeferred();
    const readCounts: Array<() => number> = [];
    const nativeOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await nativeOpen(...args);
      if (String(args[0]) === source) {
        const read = vi.spyOn(handle, "read");
        readCounts.push(() => read.mock.calls.length);
        opened.resolve();
        await release.promise;
      }
      return handle;
    });
    const delivery = normalizeWebchatReplyMediaPathsForDisplay({
      ...scope,
      payloads: [{ mediaUrls: [source], trustedLocalMedia: false }],
    });
    const rejected = expect(delivery).rejects.toThrow("Session media access changed");
    try {
      await opened.promise;
      await replaceSessionEntry(target, { ...entry, sessionRoot: testState.statePath("other") });
    } finally {
      release.resolve();
    }
    await rejected;
    expect(readCounts.length).toBeGreaterThan(0);
    expect(readCounts.reduce((total, count) => total + count(), 0)).toBe(0);
    expect(await fs.readFile(source)).toEqual(PNG_BYTES);
  });

  it("respects inherited workspace ownership when staging local attachments", async () => {
    const { cfg } = createMediaTestContext({ allowRead: false });
    const worktree = testState.statePath("worktrees", "project");
    const sourcePath = path.join(worktree, "chart.png");
    await fs.mkdir(path.join(worktree, "nested"), { recursive: true });
    await fs.writeFile(sourcePath, PNG_BYTES);
    const sessionEntry: SessionEntry = {
      sessionId: "workspace-media-session",
      updatedAt: 1,
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: worktree,
      spawnedCwd: path.join(worktree, "nested"),
    };
    const scope = await seedWebchatReplyMediaScope({
      cfg,
      agentId: "main",
      sessionKey: TEST_SESSION_KEY,
      sessionEntry,
    });
    const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
      ...scope,
      payloads: [{ mediaUrls: ["./chart.png"] }],
    });
    const stagedPath = requireString(payload?.mediaUrls?.[0], "staged workspace image");
    expect(await fs.readFile(stagedPath)).toEqual(PNG_BYTES);
    const { assistantContent } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: [{ mediaUrls: [sourcePath], trustedLocalMedia: true }],
      managedMediaLocalRoots: getWebchatReplyMediaLocalRoots(scope),
    });
    expect(assistantContent).toEqual([expect.objectContaining({ type: "image" })]);
  });

  it.each([
    { mode: "workspace", configured: false, confined: true },
    { mode: "full", configured: true, confined: false },
    { mode: undefined, configured: true, confined: true },
    { mode: undefined, configured: false, confined: false },
  ] satisfies Array<{
    mode: SessionEntry["permissionMode"];
    configured: boolean;
    confined: boolean;
  }>)(
    "uses session media permissions before configured containment ($mode, configured=$configured)",
    async ({ mode, configured, confined }) => {
      const { cfg, workspaceDir } = createMediaTestContext({ allowRead: true });
      cfg.tools = { ...cfg.tools, fs: { workspaceOnly: configured } };
      const selected = testState.statePath("worktrees", "selected");
      const directories = [
        selected,
        workspaceDir,
        testState.statePath("worktrees", "sibling"),
        testState.path("outside"),
      ];
      const labels = ["selected", "agent", "sibling", "outside"];
      const imagePaths = directories.map((directory, index) =>
        path.join(directory, `${labels[index]}.png`),
      );
      const audioPaths = directories.map((directory, index) =>
        path.join(directory, `${labels[index]}.mp3`),
      );
      for (const [index, directory] of directories.entries()) {
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(imagePaths[index]!, PNG_BYTES);
        await createAudioFile(audioPaths[index]!);
      }
      const sessionEntry: SessionEntry = {
        sessionId: "permission-media-session",
        updatedAt: 1,
        sessionRoot: selected,
        permissionMode: mode,
      };
      const scope = await seedWebchatReplyMediaScope({
        cfg,
        agentId: "main",
        sessionKey: TEST_SESSION_KEY,
        sessionEntry,
      });
      const payloads = await normalizeWebchatReplyMediaPathsForDisplay({
        ...scope,
        payloads: imagePaths.map((source) => ({ mediaUrls: [source] })),
      });
      for (const [index, payload] of payloads.entries()) {
        if (!confined || index === 0) {
          const staged = requireString(payload.mediaUrls?.[0], "staged permission-scoped image");
          expect(staged).not.toBe(imagePaths[index]);
          expect(await fs.readFile(staged)).toEqual(PNG_BYTES);
        } else {
          expect(payload.mediaUrls).toBeUndefined();
          expect(payload.text).toContain(`${labels[index]}.png: Delivery failed.`);
        }
      }
      const trustedAudioPayloads = await normalizeWebchatReplyMediaPathsForDisplay({
        ...scope,
        payloads: audioPaths.map((source) => ({ mediaUrls: [source], trustedLocalMedia: true })),
      });
      const localRoots = getWebchatReplyMediaLocalRoots(scope);
      const { assistantContent } = await buildAssistantReplyContent({
        sessionKey: TEST_SESSION_KEY,
        agentId: "main",
        payloads: trustedAudioPayloads,
        managedMediaLocalRoots: localRoots,
      });
      // Trusted playback keeps established agent access in full mode, never source-parent expansion.
      expect(assistantContent?.map((block) => block.type)).toEqual(
        confined
          ? ["audio", "attachment_error", "attachment_error", "attachment_error"]
          : ["audio", "audio", "attachment_error", "attachment_error"],
      );
    },
  );

  it("keeps sender read denial authoritative in full mode", async () => {
    const permissionMode = "full";
    const { cfg } = createMediaTestContext({ allowRead: true });
    cfg.tools = { ...cfg.tools, toolsBySender: { "*": { deny: ["read"] } } };
    const selected = testState.statePath("worktrees", "sender-policy");
    const source = path.join(selected, "private.png");
    await fs.mkdir(selected, { recursive: true });
    await fs.writeFile(source, PNG_BYTES);
    const scope = await seedWebchatReplyMediaScope({
      cfg,
      agentId: "main",
      sessionKey: TEST_SESSION_KEY,
      sessionEntry: {
        sessionId: "sender-media-session",
        updatedAt: 1,
        sessionRoot: selected,
        permissionMode,
      },
    });
    const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
      ...scope,
      payloads: [{ mediaUrls: [source] }],
    });
    expect(payload?.mediaUrls).toBeUndefined();
    expect(payload?.text).toContain("private.png: Delivery failed.");
    expect(payload?.text).not.toContain(source);
    await expect(fs.stat(testState.statePath("media", "outbound"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves unmounted sandbox containment in full mode", async () => {
    const permissionMode = "full";
    const { cfg } = createMediaTestContext({ allowRead: true });
    const selected = testState.statePath("worktrees", "sandbox-host");
    cfg.agents = {
      ...cfg.agents,
      defaults: {
        skipBootstrap: true,
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "none",
          workspaceRoot: testState.statePath("sandboxes"),
        },
      },
    };
    const source = path.join(selected, "host.png");
    await fs.mkdir(selected, { recursive: true });
    await fs.writeFile(source, PNG_BYTES);
    const sandbox = await ensureSandboxWorkspaceForSession({
      config: cfg,
      agentId: "main",
      sessionKey: TEST_SESSION_KEY,
      workspaceDir: selected,
    });
    if (!sandbox) {
      throw new Error("expected sandbox workspace");
    }
    await fs.writeFile(path.join(sandbox.workspaceDir, "sandbox.png"), PNG_BYTES);
    const scope = await seedWebchatReplyMediaScope({
      cfg,
      agentId: "main",
      sessionKey: TEST_SESSION_KEY,
      sessionEntry: {
        sessionId: "sandbox-media-session",
        updatedAt: 1,
        sessionRoot: selected,
        permissionMode,
      },
    });
    const payloads = await normalizeWebchatReplyMediaPathsForDisplay({
      ...scope,
      payloads: [{ mediaUrls: [source] }, { mediaUrls: ["./sandbox.png"] }],
    });
    expect(payloads[0]?.mediaUrls).toBeUndefined();
    expect(payloads[0]?.text).toContain("host.png: Delivery failed.");
    const staged = requireString(payloads[1]?.mediaUrls?.[0], "staged sandbox image");
    expect(await fs.readFile(staged)).toEqual(PNG_BYTES);
  });

  it.each(["exec-node", "repository", "rootless-cloud"] as const)(
    "keeps %s media on its own host in full mode",
    async (owner) => {
      const { cfg, workspaceDir } = createMediaTestContext({ allowRead: true });
      cfg.tools = { ...cfg.tools, fs: { workspaceOnly: false } };
      const remoteWorkspace = testState.statePath("worktrees", "remote");
      const storePath = testState.statePath("sessions", "session.sqlite");
      const rawDirectories = [workspaceDir, remoteWorkspace, path.dirname(storePath)];
      const rawImages = rawDirectories.map((directory, index) =>
        path.join(directory, `local-${index}.png`),
      );
      const rawAudio = rawDirectories.map((directory, index) =>
        path.join(directory, `local-${index}.mp3`),
      );
      for (const [index, directory] of rawDirectories.entries()) {
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(rawImages[index]!, PNG_BYTES);
        await createAudioFile(rawAudio[index]!);
      }
      const sessionEntry: SessionEntry = {
        sessionId: "remote-policy-session",
        updatedAt: 1,
        permissionMode: "full",
        ...(owner === "rootless-cloud" ? {} : { sessionRoot: remoteWorkspace }),
        ...(owner === "exec-node" ? { execNode: "remote-node" } : {}),
        ...(owner === "repository" ? { repositoryWorkspaceId: "remote-project" } : {}),
      };
      if (owner === "rootless-cloud") {
        await createWorkerSessionPlacementStore().startDispatch({
          sessionId: sessionEntry.sessionId,
          sessionKey: TEST_SESSION_KEY,
          agentId: "main",
        });
      }
      const managedImages = await Promise.all(
        ["inbound", "outbound", "tool-remote"].map(
          async (bucket) => (await saveMediaBuffer(PNG_BYTES, "image/png", bucket)).path,
        ),
      );
      const remoteUrl = "https://example.test/remote.png";
      const dataUrl = dataImageUrl();
      const sources = [...rawImages, ...managedImages, remoteUrl, dataUrl];
      const scope = await seedWebchatReplyMediaScope({
        cfg,
        agentId: "main",
        sessionKey: TEST_SESSION_KEY,
        sessionEntry,
      });
      const payloads = await normalizeWebchatReplyMediaPathsForDisplay({
        ...scope,
        payloads: sources.map((source) => ({ mediaUrls: [source] })),
      });
      for (const payload of payloads.slice(0, rawImages.length)) {
        expect(payload.mediaUrls).toBeUndefined();
        expect(payload.text).toContain("Delivery failed.");
      }
      for (const payload of payloads.slice(
        rawImages.length,
        rawImages.length + managedImages.length,
      )) {
        const staged = requireString(payload.mediaUrls?.[0], "managed remote-session image");
        expect(await fs.readFile(staged)).toEqual(PNG_BYTES);
      }
      expect(payloads.at(-2)?.mediaUrls).toEqual([remoteUrl]);
      expect(payloads.at(-1)?.mediaUrls).toEqual([dataUrl]);
      const managedAudio = await Promise.all(
        ["inbound", "outbound", "tool-remote", "outgoing/originals", "playback-transcode"].map(
          async (bucket) =>
            (await saveMediaBuffer(Buffer.from([0xff, 0xfb, 0x90, 0x00]), "audio/mpeg", bucket))
              .path,
        ),
      );
      const localRoots = getWebchatReplyMediaLocalRoots({ ...scope, storePath });
      const { assistantContent } = await buildAssistantReplyContent({
        sessionKey: TEST_SESSION_KEY,
        agentId: "main",
        payloads: [...rawAudio, ...managedAudio].map((source) => ({
          mediaUrls: [source],
          trustedLocalMedia: true,
        })),
        managedMediaLocalRoots: localRoots,
      });
      expect(assistantContent?.map((block) => block.type)).toEqual([
        "attachment_error",
        "attachment_error",
        "attachment_error",
        "audio",
        "audio",
        "audio",
        "audio",
        "audio",
      ]);
    },
  );

  it("rejects managed-directory aliases to remote sessions' Gateway-local files", async () => {
    const { cfg } = createMediaTestContext({ allowRead: true });
    const outside = testState.path("outside-managed-store");
    const source = path.join(outside, "private.mp3");
    await createAudioFile(source);
    const alias = path.join(getMediaDir(), "tool-remote-alias");
    await fs.mkdir(getMediaDir(), { recursive: true });
    await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
    const aliasedSource = path.join(alias, "private.mp3");
    const sessionEntry: SessionEntry = {
      sessionId: "remote-alias-session",
      updatedAt: 1,
      execNode: "remote-node",
      permissionMode: "full",
    };
    const scope = await seedWebchatReplyMediaScope({
      cfg,
      agentId: "main",
      sessionKey: TEST_SESSION_KEY,
      sessionEntry,
    });
    const [untrusted] = await normalizeWebchatReplyMediaPathsForDisplay({
      ...scope,
      payloads: [{ mediaUrls: [aliasedSource] }],
    });
    expect(untrusted?.mediaUrls).toBeUndefined();
    const { assistantContent } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: [{ mediaUrls: [aliasedSource], trustedLocalMedia: true }],
      managedMediaLocalRoots: getWebchatReplyMediaLocalRoots(scope),
    });
    expect(assistantContent).toEqual([expect.objectContaining({ type: "attachment_error" })]);
  });
});
