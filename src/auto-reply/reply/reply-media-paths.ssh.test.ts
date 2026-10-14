import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxFsBridge } from "../../agents/sandbox/fs-bridge.types.js";
import type { SandboxContext } from "../../agents/sandbox/types.js";
import { WEBCHAT_LOCAL_MEDIA_MAX_BYTES } from "../../media/configured-max-bytes.js";
import { saveMediaBuffer } from "../../media/store.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { createReplyMediaPathNormalizer } from "./reply-media-paths.js";

const sandboxMocks = vi.hoisted(() => ({
  ensureSandboxWorkspaceForSession: vi.fn(),
  resolveSandboxContext: vi.fn<() => Promise<SandboxContext | null>>(),
}));
// mock-isolation: Prevent real SSH provisioning; media loading and read policy stay real.
vi.mock("../../agents/sandbox.js", () => sandboxMocks);

describe("SSH reply media", () => {
  let state: OpenClawTestState;
  let sandbox: SandboxContext;
  const bytes = Buffer.from("# Remote draft\nOnly the SSH workspace owns these bytes.\n");
  const readFile = vi.fn<SandboxFsBridge["readFile"]>();
  const dispose = vi.fn();

  beforeEach(async () => {
    state = await createOpenClawTestState({ layout: "state-only" });
    readFile.mockReset().mockResolvedValue(bytes);
    dispose.mockReset();
    const workspaceDir = state.statePath("workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    // A stale local copy must never win over the remote canonical file.
    await fs.mkdir(path.join(workspaceDir, "notes"));
    await fs.writeFile(path.join(workspaceDir, "notes/draft.md"), "stale host draft");
    sandbox = {
      enabled: true,
      backendId: "ssh",
      sessionKey: "agent:main:ssh-reply",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      workspaceAccess: "rw",
      runtimeId: "ssh-reply",
      runtimeLabel: "SSH test workspace",
      containerName: "ssh-reply",
      containerWorkdir: "/remote/workspace",
      docker: {
        image: "unused",
        containerPrefix: "unused",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: [],
        network: "none",
        capDrop: [],
      },
      tools: {},
      browserAllowHostControl: false,
      fsBridge: {
        readFile,
        resolvePath: () => {
          throw new Error("unexpected resolvePath");
        },
        writeFile: async () => {
          throw new Error("unexpected writeFile");
        },
        mkdirp: async () => {
          throw new Error("unexpected mkdirp");
        },
        remove: async () => {
          throw new Error("unexpected remove");
        },
        rename: async () => {
          throw new Error("unexpected rename");
        },
        stat: async () => null,
      },
      [Symbol.dispose]: dispose,
    };
    sandboxMocks.resolveSandboxContext.mockReset().mockResolvedValue(sandbox);
    sandboxMocks.ensureSandboxWorkspaceForSession.mockReset().mockResolvedValue(sandbox);
  });

  afterEach(async () => {
    await drainGlobalSingletonLifecycleState();
    await state.cleanup();
  });

  function normalizer(options: Partial<Parameters<typeof createReplyMediaPathNormalizer>[0]> = {}) {
    return createReplyMediaPathNormalizer({
      cfg: {
        agents: {
          defaults: {
            sandbox: { mode: "all", backend: "ssh", workspaceAccess: sandbox.workspaceAccess },
          },
        },
      },
      sessionKey: sandbox.sessionKey,
      agentId: "main",
      workspaceDir: sandbox.workspaceDir,
      ...options,
    });
  }

  it.each([
    { name: "WebChat", options: { localMediaMaxBytes: WEBCHAT_LOCAL_MEDIA_MAX_BYTES } },
    { name: "channel delivery", options: { messageProvider: "slack" } },
  ])(
    "hydrates $name attachments from the bridge instead of the host mirror",
    async ({ options }) => {
      const result = await normalizer(options)({
        text: "Draft attached",
        mediaUrls: ["notes/draft.md"],
      });
      expect(result.mediaUrl).toBeDefined();
      expect(await fs.readFile(result.mediaUrl!)).toEqual(bytes);
      expect(result.attachments?.[0]).toMatchObject({
        name: "draft.md",
        mimeType: "text/markdown",
      });
      expect(getReplyPayloadMetadata(result)?.assistantMediaFailures).toBeUndefined();
      expect(readFile).toHaveBeenCalledWith({
        filePath: path.join(sandbox.workspaceDir, "notes/draft.md"),
        cwd: sandbox.workspaceDir,
        // The media loader reserves 24 MiB of source-read headroom for image optimization.
        maxBytes: 24 * 1024 * 1024,
      });
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("maps remote absolute paths and blocks paths outside the workspace", async () => {
    const result = await normalizer()({
      mediaUrls: ["/remote/workspace/notes/draft.md", "../outside.md", "/etc/passwd"],
    });
    expect(await fs.readFile(result.mediaUrl!)).toEqual(bytes);
    expect(result.mediaUrls).toHaveLength(1);
    expect(getReplyPayloadMetadata(result)?.assistantMediaFailures).toHaveLength(2);
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("keeps denied workspace access from reading the host mirror or bridge", async () => {
    sandbox.workspaceAccess = "none";
    const result = await normalizer()({ mediaUrls: ["notes/draft.md"] });
    expect(result.mediaUrls).toBeUndefined();
    expect(getReplyPayloadMetadata(result)?.assistantMediaFailures).toHaveLength(1);
    expect(readFile).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects unsupported HTML without reading remote bytes", async () => {
    const result = await normalizer()({ mediaUrls: ["report.html"] });
    expect(result.mediaUrls).toBeUndefined();
    expect(getReplyPayloadMetadata(result)?.assistantMediaFailures?.[0]?.code).toBe(
      "unsupported-format",
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it("keeps reply text, managed media and HTTP attachments when SSH preparation fails", async () => {
    const managed = await saveMediaBuffer(
      Buffer.from([0xff, 0xfb, 0x90, 0x00]),
      "audio/mpeg",
      "tool-speech-synthesis",
    );
    sandboxMocks.resolveSandboxContext.mockRejectedValue(new Error("SSH unavailable"));
    sandboxMocks.ensureSandboxWorkspaceForSession.mockRejectedValue(new Error("SSH unavailable"));
    const result = await normalizer()({
      text: "Draft attached",
      mediaUrls: ["notes/draft.md", managed.path, "https://example.com/image.png"],
    });
    expect(result.text).toContain("Draft attached");
    expect(result.mediaUrls).toEqual([managed.path, "https://example.com/image.png"]);
    expect(getReplyPayloadMetadata(result)?.assistantMediaFailures).toHaveLength(1);
    expect(readFile).not.toHaveBeenCalled();
  });
});
