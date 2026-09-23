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
        list: [
          {
            id: "main",
            agentDir: testState.statePath("agents", "main", "agent"),
            workspace: workspaceDir,
          },
        ],
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

  it.each([
    ["staging", "permission"],
    ["staging", "workspace"],
    ["staging", "placement"],
    ["trusted-audio", "permission"],
    ["trusted-audio", "workspace"],
    ["trusted-audio", "placement"],
  ] as const)("stops %s before file content I/O when %s changes", async (flow, change) => {
    const { cfg } = createMediaTestContext({ allowRead: true });
    cfg.tools = { ...cfg.tools, fs: { workspaceOnly: true } };
    const selected = testState.statePath("worktrees", "selected");
    const source = path.join(
      change === "permission" ? testState.statePath("workspace") : selected,
      flow === "staging" ? "chart.png" : "speech.mp3",
    );
    await fs.mkdir(selected, { recursive: true });
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, flow === "staging" ? PNG_BYTES : Buffer.from([0xff, 0xfb, 0x90, 0]));
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
    const payload = { mediaUrls: [source], trustedLocalMedia: flow === "trusted-audio" };
    const delivery =
      flow === "staging"
        ? normalizeWebchatReplyMediaPathsForDisplay({ ...scope, payloads: [payload] })
        : buildAssistantReplyContent({
            sessionKey: TEST_SESSION_KEY,
            agentId: "main",
            payloads: [payload],
            managedMediaLocalRoots: getWebchatReplyMediaLocalRoots(scope),
            assertCurrent: scope.assertCurrent,
          });
    const rejected = expect(delivery).rejects.toThrow("Session media access changed");
    try {
      await opened.promise;
      await replaceSessionEntry(target, {
        ...entry,
        ...(change === "permission" ? { permissionMode: "workspace" } : {}),
        ...(change === "workspace" ? { sessionRoot: testState.statePath("other") } : {}),
        ...(change === "placement" ? { execNode: "remote-test-node" } : {}),
      });
    } finally {
      release.resolve();
    }
    await rejected;
    expect(readCounts.length).toBeGreaterThan(0);
    expect(readCounts.reduce((total, count) => total + count(), 0)).toBe(0);
    expect(await fs.readFile(source)).toEqual(
      flow === "staging" ? PNG_BYTES : Buffer.from([0xff, 0xfb, 0x90, 0]),
    );
  });

  it.each(["inherited", "exec-node", "repository", "cloud", "sibling"] as const)(
    "respects the %s workspace ownership when staging local attachments",
    async (ownership) => {
      const { cfg } = createMediaTestContext({ allowRead: false });
      const worktree = testState.statePath("worktrees", "project");
      const sourcePath = path.join(
        ownership === "sibling" ? testState.statePath("worktrees", "other") : worktree,
        "chart.png",
      );
      await fs.mkdir(path.join(worktree, "nested"), { recursive: true });
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, PNG_BYTES);
      const sessionEntry: SessionEntry = {
        sessionId: "workspace-media-session",
        updatedAt: 1,
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: worktree,
        spawnedCwd: path.join(worktree, "nested"),
        ...(ownership === "exec-node" ? { execNode: "remote-node" } : {}),
        ...(ownership === "repository" ? { repositoryWorkspaceId: "remote-repository" } : {}),
      };
      if (ownership === "cloud") {
        createWorkerSessionPlacementStore().startDispatch({
          sessionId: sessionEntry.sessionId,
          sessionKey: TEST_SESSION_KEY,
          agentId: "main",
        });
      }
      const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
        cfg,
        agentId: "main",
        sessionKey: TEST_SESSION_KEY,
        sessionEntry,
        payloads: [{ mediaUrls: [ownership === "inherited" ? "./chart.png" : sourcePath] }],
      });
      if (ownership === "inherited") {
        const stagedPath = requireString(payload?.mediaUrls?.[0], "staged workspace image");
        expect(await fs.readFile(stagedPath)).toEqual(PNG_BYTES);
      } else {
        expect(payload?.mediaUrls).toBeUndefined();
        expect(payload?.text).toBe("⚠️ chart.png: Delivery failed. Try sending this file again.");
      }
      const { assistantContent } = await buildAssistantReplyContent({
        sessionKey: TEST_SESSION_KEY,
        agentId: "main",
        payloads: [{ mediaUrls: [sourcePath], trustedLocalMedia: true }],
        managedMediaLocalRoots: getWebchatReplyMediaLocalRoots({
          cfg,
          agentId: "main",
          sessionEntry,
        }),
      });
      expect(assistantContent).toEqual([
        expect.objectContaining({ type: ownership === "inherited" ? "image" : "attachment_error" }),
      ]);
    },
  );

  it.each([
    { mode: "workspace", configured: false, confined: true },
    { mode: "guarded", configured: false, confined: true },
    { mode: "read-only", configured: false, confined: true },
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
      const payloads = await normalizeWebchatReplyMediaPathsForDisplay({
        cfg,
        agentId: "main",
        sessionKey: TEST_SESSION_KEY,
        sessionEntry,
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
        cfg,
        agentId: "main",
        sessionKey: TEST_SESSION_KEY,
        sessionEntry,
        payloads: audioPaths.map((source) => ({ mediaUrls: [source], trustedLocalMedia: true })),
      });
      const localRoots = getWebchatReplyMediaLocalRoots({ cfg, agentId: "main", sessionEntry });
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

  it.each(["workspace", "full"] as const)(
    "keeps sender read denial authoritative in %s mode",
    async (permissionMode) => {
      const { cfg } = createMediaTestContext({ allowRead: true });
      cfg.tools = { ...cfg.tools, toolsBySender: { "*": { deny: ["read"] } } };
      const selected = testState.statePath("worktrees", "sender-policy");
      const source = path.join(selected, "private.png");
      await fs.mkdir(selected, { recursive: true });
      await fs.writeFile(source, PNG_BYTES);
      const [payload] = await normalizeWebchatReplyMediaPathsForDisplay({
        cfg,
        agentId: "main",
        sessionKey: TEST_SESSION_KEY,
        sessionEntry: {
          sessionId: "sender-media-session",
          updatedAt: 1,
          sessionRoot: selected,
          permissionMode,
        },
        payloads: [{ mediaUrls: [source] }],
      });
      expect(payload?.mediaUrls).toBeUndefined();
      expect(payload?.text).toContain("private.png: Delivery failed.");
      await expect(fs.stat(testState.statePath("media", "outbound"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.each(["workspace", "full"] as const)(
    "preserves unmounted sandbox containment in %s mode",
    async (permissionMode) => {
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
      const payloads = await normalizeWebchatReplyMediaPathsForDisplay({
        cfg,
        agentId: "main",
        sessionKey: TEST_SESSION_KEY,
        sessionEntry: {
          sessionId: "sandbox-media-session",
          updatedAt: 1,
          sessionRoot: selected,
          permissionMode,
        },
        payloads: [{ mediaUrls: [source] }, { mediaUrls: ["./sandbox.png"] }],
      });
      expect(payloads[0]?.mediaUrls).toBeUndefined();
      expect(payloads[0]?.text).toContain("host.png: Delivery failed.");
      const staged = requireString(payloads[1]?.mediaUrls?.[0], "staged sandbox image");
      expect(await fs.readFile(staged)).toEqual(PNG_BYTES);
    },
  );

  it.each([
    { owner: "exec-node", configured: false },
    { owner: "repository", configured: false },
    { owner: "cloud", configured: false },
    { owner: "rootless-cloud", configured: false },
    { owner: "exec-node", configured: true },
    { owner: "repository", configured: true },
    { owner: "cloud", configured: true },
    { owner: "rootless-cloud", configured: true },
  ] as const)(
    "keeps $owner media on its own host in full mode (configured containment=$configured)",
    async ({ owner, configured }) => {
      const { cfg, workspaceDir } = createMediaTestContext({ allowRead: true });
      cfg.tools = { ...cfg.tools, fs: { workspaceOnly: configured } };
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
      if (owner === "cloud" || owner === "rootless-cloud") {
        createWorkerSessionPlacementStore().startDispatch({
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
      const payloads = await normalizeWebchatReplyMediaPathsForDisplay({
        cfg,
        agentId: "main",
        sessionKey: TEST_SESSION_KEY,
        sessionEntry,
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
      const localRoots = getWebchatReplyMediaLocalRoots({
        cfg,
        agentId: "main",
        sessionEntry,
        storePath,
      });
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
    const [untrusted] = await normalizeWebchatReplyMediaPathsForDisplay({
      cfg,
      agentId: "main",
      sessionKey: TEST_SESSION_KEY,
      sessionEntry,
      payloads: [{ mediaUrls: [aliasedSource] }],
    });
    expect(untrusted?.mediaUrls).toBeUndefined();
    const { assistantContent } = await buildAssistantReplyContent({
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
      payloads: [{ mediaUrls: [aliasedSource], trustedLocalMedia: true }],
      managedMediaLocalRoots: getWebchatReplyMediaLocalRoots({
        cfg,
        agentId: "main",
        sessionEntry,
      }),
    });
    expect(assistantContent).toEqual([expect.objectContaining({ type: "attachment_error" })]);
  });
});
