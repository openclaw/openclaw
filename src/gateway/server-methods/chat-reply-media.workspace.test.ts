import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { onTestFinished, beforeEach, describe, expect, it } from "vitest";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getMediaDir, saveMediaBuffer } from "../../media/store.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { buildAssistantReplyContent } from "./chat-assistant-content.js";
import {
  AUDIO_BYTES,
  PNG_BYTES,
  gateMediaOpen,
  useMediaState,
  writeMedia,
} from "./chat-media-fixture.test-support.js";
import {
  getWebchatReplyMediaLocalRoots,
  normalizeWebchatReplyMediaPathsForDisplay,
} from "./chat-reply-media.js";
import { seedWebchatReplyMediaScope } from "./chat-reply-media.test-support.js";

const TEST_SESSION_KEY = "agent:main:webchat:direct:user";

describe("WebChat reply media workspace ownership", () => {
  let testState: OpenClawTestState;
  const getState = useMediaState();
  beforeEach(() => {
    testState = getState();
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
    setRuntimeConfigSnapshot(cfg);
    return { cfg, workspaceDir };
  }

  async function seedScope(cfg: OpenClawConfig, entry: Partial<SessionEntry>) {
    const scope = await seedWebchatReplyMediaScope({
      cfg,
      agentId: "main",
      sessionKey: TEST_SESSION_KEY,
      sessionEntry: { sessionId: "media-session", updatedAt: 1, ...entry },
    });
    onTestFinished(scope.release);
    return scope;
  }

  function normalize(
    scope: Awaited<ReturnType<typeof seedScope>>,
    sources: string[],
    trustedLocalMedia = false,
  ) {
    return normalizeWebchatReplyMediaPathsForDisplay({
      ...scope,
      payloads: sources.map((source) => ({ mediaUrls: [source], trustedLocalMedia })),
    });
  }

  async function content(
    scope: Awaited<ReturnType<typeof seedScope>>,
    payloads: Parameters<typeof buildAssistantReplyContent>[0]["payloads"],
    storePath?: string,
  ) {
    return (
      await buildAssistantReplyContent({
        sessionKey: TEST_SESSION_KEY,
        agentId: "main",
        payloads,
        managedMediaLocalRoots: getWebchatReplyMediaLocalRoots({ ...scope, storePath }),
      })
    ).assistantContent;
  }

  async function expectImage(staged: string | undefined) {
    expect(await fs.readFile(expectDefined(staged, "staged image"))).toEqual(PNG_BYTES);
  }

  async function mediaFiles(directories: string[], labels: string[]) {
    const images = directories.map((dir, i) => path.join(dir, `${labels[i]}.png`));
    const audio = directories.map((dir, i) => path.join(dir, `${labels[i]}.mp3`));
    for (const [i, image] of images.entries()) {
      await writeMedia(image);
      await writeMedia(audio[i]!, AUDIO_BYTES);
    }
    return { images, audio };
  }

  it("stops staging before file content I/O when the workspace changes", async () => {
    const { cfg } = createMediaTestContext({ allowRead: true });
    cfg.tools = { ...cfg.tools, fs: { workspaceOnly: true } };
    const selected = testState.statePath("worktrees", "selected");
    const source = await writeMedia(path.join(selected, "chart.png"));
    const target = {
      sessionKey: TEST_SESSION_KEY,
      agentId: "main",
    };
    const entry: SessionEntry = {
      sessionId: "changing-media-policy",
      lifecycleRevision: "initial",
      permissionMode: "full",
      sessionRoot: selected,
      updatedAt: 1,
    };
    const scope = await seedScope(cfg, entry);
    const gate = gateMediaOpen(source);
    const delivery = normalize(scope, [source]);
    const rejected = expect(delivery).rejects.toThrow("Session media access changed");
    try {
      await gate.opened;
      await replaceSessionEntry(target, { ...entry, sessionRoot: testState.statePath("other") });
    } finally {
      gate.release();
    }
    await rejected;
    gate.assertUnread();
    expect(await fs.readFile(source)).toEqual(PNG_BYTES);
  });

  it("respects inherited workspace ownership when staging local attachments", async () => {
    const { cfg } = createMediaTestContext({ allowRead: false });
    const worktree = testState.statePath("worktrees", "project");
    await fs.mkdir(path.join(worktree, "nested"), { recursive: true });
    const sourcePath = await writeMedia(path.join(worktree, "chart.png"));
    const scope = await seedScope(cfg, {
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: worktree,
      spawnedCwd: path.join(worktree, "nested"),
    });
    const [payload] = await normalize(scope, ["./chart.png"]);
    await expectImage(payload?.mediaUrls?.[0]);
    const assistantContent = await content(scope, [
      { mediaUrls: [sourcePath], trustedLocalMedia: true },
    ]);
    expect(assistantContent).toEqual([expect.objectContaining({ type: "image" })]);
  });

  it.each([
    { mode: "workspace", configured: false, confined: true },
    { mode: "full", configured: true, confined: false },
    { mode: undefined, configured: true, confined: true },
    { mode: undefined, configured: false, confined: false },
  ] as const)(
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
      const { images: imagePaths, audio: audioPaths } = await mediaFiles(directories, labels);
      const scope = await seedScope(cfg, {
        sessionRoot: selected,
        permissionMode: mode,
      });
      const payloads = await normalize(scope, imagePaths);
      for (const [index, payload] of payloads.entries()) {
        if (!confined || index === 0) {
          const staged = payload.mediaUrls?.[0];
          expect(staged).not.toBe(imagePaths[index]);
          await expectImage(staged);
        } else {
          expect(payload.mediaUrls).toBeUndefined();
          expect(payload.text).toContain(`${labels[index]}.png: Delivery failed.`);
        }
      }
      const assistantContent = await content(scope, await normalize(scope, audioPaths, true));
      // Trusted playback keeps established agent access in full mode, never source-parent expansion.
      expect(assistantContent?.map((block) => block.type)).toEqual(
        confined
          ? ["audio", "attachment_error", "attachment_error", "attachment_error"]
          : ["audio", "audio", "attachment_error", "attachment_error"],
      );
    },
  );

  it("keeps sender read denial authoritative in full mode", async () => {
    const { cfg } = createMediaTestContext({ allowRead: true });
    cfg.tools = { ...cfg.tools, toolsBySender: { "*": { deny: ["read"] } } };
    const selected = testState.statePath("worktrees", "sender-policy");
    const source = await writeMedia(path.join(selected, "private.png"));
    const scope = await seedScope(cfg, {
      sessionRoot: selected,
      permissionMode: "full",
    });
    const [payload] = await normalize(scope, [source]);
    expect(payload?.mediaUrls).toBeUndefined();
    expect(payload?.text).toContain("private.png: Delivery failed.");
    expect(payload?.text).not.toContain(source);
    await expect(fs.stat(testState.statePath("media", "outbound"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves unmounted sandbox containment in full mode", async () => {
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
    const source = await writeMedia(path.join(selected, "host.png"));
    const sandbox = await ensureSandboxWorkspaceForSession({
      config: cfg,
      agentId: "main",
      sessionKey: TEST_SESSION_KEY,
      workspaceDir: selected,
    });
    await writeMedia(
      path.join(expectDefined(sandbox, "sandbox workspace").workspaceDir, "sandbox.png"),
    );
    const scope = await seedScope(cfg, {
      sessionRoot: selected,
      permissionMode: "full",
    });
    const payloads = await normalize(scope, [source, "./sandbox.png"]);
    expect(payloads[0]?.mediaUrls).toBeUndefined();
    expect(payloads[0]?.text).toContain("host.png: Delivery failed.");
    await expectImage(payloads[1]?.mediaUrls?.[0]);
  });

  it.each(["exec-node", "repository", "device-folder", "rootless-cloud"] as const)(
    "keeps %s media on its own host in full mode",
    async (owner) => {
      const { cfg, workspaceDir } = createMediaTestContext({ allowRead: true });
      cfg.tools = { ...cfg.tools, fs: { workspaceOnly: false } };
      const remoteWorkspace = testState.statePath("worktrees", "remote");
      const storePath = testState.statePath("sessions", "session.sqlite");
      const rawDirectories = [workspaceDir, remoteWorkspace, path.dirname(storePath)];
      const { images: rawImages, audio: rawAudio } = await mediaFiles(
        rawDirectories,
        rawDirectories.map((_, index) => `local-${index}`),
      );
      const sessionEntry: SessionEntry = {
        sessionId: "remote-policy-session",
        updatedAt: 1,
        permissionMode: "full",
        ...(owner === "rootless-cloud" ? {} : { sessionRoot: remoteWorkspace }),
        ...(owner === "exec-node" ? { execNode: "remote-node" } : {}),
        ...(owner === "repository" ? { repositoryWorkspaceId: "remote-project" } : {}),
        ...(owner === "device-folder"
          ? { deviceFolder: { deviceId: "paired-device", path: remoteWorkspace } }
          : {}),
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
      const dataUrl = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
      const sources = [...rawImages, ...managedImages, remoteUrl, dataUrl];
      const scope = await seedScope(cfg, sessionEntry);
      const payloads = await normalize(scope, sources);
      for (const payload of payloads.slice(0, rawImages.length)) {
        expect(payload.mediaUrls).toBeUndefined();
        expect(payload.text).toContain("Delivery failed.");
      }
      for (const payload of payloads.slice(
        rawImages.length,
        rawImages.length + managedImages.length,
      )) {
        await expectImage(payload.mediaUrls?.[0]);
      }
      expect(payloads.at(-2)?.mediaUrls).toEqual([remoteUrl]);
      expect(payloads.at(-1)?.mediaUrls).toEqual([dataUrl]);
      const managedAudio = await Promise.all(
        ["inbound", "outbound", "tool-remote", "outgoing/originals", "playback-transcode"].map(
          async (bucket) => (await saveMediaBuffer(AUDIO_BYTES, "audio/mpeg", bucket)).path,
        ),
      );
      const assistantContent = await content(
        scope,
        [...rawAudio, ...managedAudio].map((source) => ({
          mediaUrls: [source],
          trustedLocalMedia: true,
        })),
        storePath,
      );
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
    await writeMedia(source, AUDIO_BYTES);
    const alias = path.join(getMediaDir(), "tool-remote-alias");
    await fs.mkdir(getMediaDir(), { recursive: true });
    await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
    const aliasedSource = path.join(alias, "private.mp3");
    const scope = await seedScope(cfg, {
      execNode: "remote-node",
      permissionMode: "full",
    });
    const [untrusted] = await normalize(scope, [aliasedSource]);
    expect(untrusted?.mediaUrls).toBeUndefined();
    const assistantContent = await content(scope, [
      { mediaUrls: [aliasedSource], trustedLocalMedia: true },
    ]);
    expect(assistantContent).toEqual([expect.objectContaining({ type: "attachment_error" })]);
  });
});
