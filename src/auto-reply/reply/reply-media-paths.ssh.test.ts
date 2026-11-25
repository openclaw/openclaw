import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SandboxFsBridge } from "../../agents/sandbox/fs-bridge.types.js";
import { createSandboxTestContext } from "../../agents/sandbox/test-fixtures.js";
import type { SandboxContext } from "../../agents/sandbox/types.js";
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
vi.mock("../../agents/sandbox/context.js", () => sandboxMocks);

function unexpected(method: string): never {
  throw new Error(`unexpected ${method}`);
}

let state: OpenClawTestState;
let sandbox: SandboxContext;
const bytes = Buffer.from("# Remote draft\nOnly the SSH workspace owns these bytes.\n");
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const readFile = vi.fn<SandboxFsBridge["readFile"]>();
const dispose = vi.fn();

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  readFile.mockReset().mockResolvedValue(bytes);
  dispose.mockReset();
  const workspaceDir = state.statePath("workspace");
  // A stale local copy must never win over the remote canonical file.
  await fs.mkdir(path.join(workspaceDir, "notes"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "notes/draft.md"), "stale host draft");
  sandbox = createSandboxTestContext({
    overrides: {
      backendId: "ssh",
      workspaceDir,
      containerWorkdir: "/remote/workspace",
      tools: {},
      fsBridge: {
        readFile,
        resolvePath: () => unexpected("resolvePath"),
        writeFile: async () => unexpected("writeFile"),
        mkdirp: async () => unexpected("mkdirp"),
        remove: async () => unexpected("remove"),
        rename: async () => unexpected("rename"),
        stat: async () => null,
      },
      [Symbol.dispose]: dispose,
    },
  });
  Object.values(sandboxMocks).forEach((mock) => mock.mockReset().mockResolvedValue(sandbox));
});

afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
  await state.cleanup();
});

function normalizer(options: Partial<Parameters<typeof createReplyMediaPathNormalizer>[0]> = {}) {
  const { workspaceAccess } = sandbox;
  const policy = { mode: "all", backend: "ssh", workspaceAccess } as const;
  return createReplyMediaPathNormalizer({
    cfg: { agents: { defaults: { sandbox: policy } } },
    sessionKey: sandbox.sessionKey,
    agentId: "main",
    workspaceDir: sandbox.workspaceDir,
    ...options,
  });
}

it("hydrates channel media from the bridge instead of the host mirror", async () => {
  const result = await normalizer({ messageProvider: "slack" })({ mediaUrls: ["notes/draft.md"] });
  expect(await fs.readFile(result.mediaUrl!)).toEqual(bytes);
  expect(result.attachments?.[0]).toMatchObject({ name: "draft.md", mimeType: "text/markdown" });
  expect(getReplyPayloadMetadata(result)?.assistantMediaFailures).toBeUndefined();
  expect(dispose).toHaveBeenCalledOnce();
});

it("maps remote absolute paths and blocks paths outside the workspace", async () => {
  const result = await normalizer()({
    mediaUrls: ["/remote/workspace/notes/draft.md", "../outside.md", "/etc/passwd"],
  });
  expect(await fs.readFile(result.mediaUrl!)).toEqual(bytes);
  expect(result.mediaUrls).toHaveLength(1);
  expect(getReplyPayloadMetadata(result)?.assistantMediaFailures).toHaveLength(2);
  expect(readFile).toHaveBeenCalledOnce();
});

it.each([
  ["denied workspace", "notes/draft.md", "none", {}],
  ["unsupported HTML", "report.html", "rw", { code: "unsupported-format" }],
] as const)("rejects %s before reads", async (_name, file, access, failure) => {
  sandbox.workspaceAccess = access;
  const result = await normalizer()({ mediaUrls: [file] });
  expect(result.mediaUrls).toBeUndefined();
  expect(getReplyPayloadMetadata(result)?.assistantMediaFailures).toMatchObject([failure]);
  expect(dispose).toHaveBeenCalledOnce();
  expect(readFile).not.toHaveBeenCalled();
});

it("keeps reply text, managed media and HTTP attachments when SSH preparation fails", async () => {
  const managed = await saveMediaBuffer(mp3, "audio/mpeg", "tool-speech-synthesis");
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
