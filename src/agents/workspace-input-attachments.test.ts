import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { stageSandboxMedia } from "../auto-reply/reply/stage-sandbox-media.js";
import { root as fsRoot } from "../infra/fs-safe.js";
import type { MediaFact } from "../media/media-facts.js";
import {
  createStagedInputPathMatcher,
  stagedInputDirectory,
  stagedInputFileName,
} from "../media/staged-inputs.js";
import { getMediaDir } from "../media/store.js";
import { buildPersistedUserTurnMessage } from "../sessions/user-turn-transcript.js";
import {
  detectAndLoadPromptImages,
  materializeProviderContext,
} from "./embedded-agent-runner/run/images.js";
import { createRemoteShellSandboxFsBridge } from "./sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "./sandbox/remote-fs-bridge.test-helpers.js";
import { buildRemoteCommand } from "./sandbox/remote-shell-command.js";
import { createRemoteShellSandboxSession } from "./sandbox/remote-shell-transport.js";
import { convertToLlm } from "./sessions/messages.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";
import { createWorkspaceAttachmentPreparer } from "./workspace-attachment-preparer.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
let root: string;
let f: Awaited<ReturnType<typeof fixture>>;
let release: () => void;

beforeEach(async () => {
  root = await fs.realpath(dirs.make("openclaw-workspace-inputs-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  await fs.mkdir(path.join(getMediaDir(), "inbound"), { recursive: true });
  await fs.mkdir(path.join(getMediaDir(), "remote-cache"));
  f = await fixture();
  release = registerAgentWorkspaceAccess(f.gateway, {
    bridge: f.bridge,
    prepareTurnAttachments: f.prepare,
  });
});
afterEach(() => {
  release();
  vi.unstubAllEnvs();
});

function createBridge(
  gateway: string,
  harness: string,
  runRemoteShellScript = createLocalRemoteShellScriptRunner(),
) {
  return createRemoteShellSandboxFsBridge({
    sandbox: {
      workspaceDir: gateway,
      agentWorkspaceDir: gateway,
      workspaceAccess: "rw",
      containerName: "fixture",
      containerWorkdir: harness,
      docker: {},
    },
    runtime: {
      remoteWorkspaceDir: harness,
      remoteAgentWorkspaceDir: harness,
      runRemoteShellScript,
    },
  });
}

async function fixture() {
  const gateway = path.join(root, "gateway");
  const harness = path.join(root, "harness");
  await fs.mkdir(gateway);
  await fs.mkdir(harness);
  const bridge = createBridge(gateway, harness);
  const create = vi.fn(bridge.createFileExclusive!.bind(bridge));
  const prepare = createWorkspaceAttachmentPreparer({
    createBridge: () => Object.assign(bridge, { createFileExclusive: create }),
    remoteRoot: harness,
  });
  const destination = (source: string) =>
    path.join(
      harness,
      stagedInputDirectory(digest(source)),
      stagedInputFileName(path.basename(source)),
    );
  return { gateway, harness, bridge, create, prepare, destination };
}

const turn = (media: MediaFact[]) => ({ timeoutMs: 60_000, media });
const prepareMedia = (media: MediaFact[]) => f.prepare(turn(media), () => {});
const loadImages = (params: Partial<Parameters<typeof detectAndLoadPromptImages>[0]>) =>
  detectAndLoadPromptImages({
    prompt: "Inspect the attachment",
    workspaceDir: f.gateway,
    model: { input: ["text", "image"] },
    sandbox: { root: f.harness, bridge: f.bridge },
    ...params,
  });
async function writeMedia(name = "inbound/report.txt", data: string | Buffer = "input") {
  const source = path.join(getMediaDir(), name);
  await fs.writeFile(source, data);
  return source;
}
// These fixtures run the Linux remote host locally (including GNU stat).
describe.runIf(process.platform === "linux")("workspace attachments over remote shell", () => {
  it("keeps images readable on Gateway and transfers their originals without a local workspace copy", async () => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
      "base64",
    );
    const source = await writeMedia("inbound/input.png", bytes);
    const media = [{ path: source, contentType: "image/png" }];
    const ctx = { media };
    await stageSandboxMedia({
      ctx,
      sessionCtx: ctx,
      cfg: {},
      sessionKey: "agent:main:test",
      workspaceDir: f.gateway,
    });
    expect(ctx.media).toBe(media);
    expect(await fs.readdir(f.gateway)).toEqual([]);
    await prepareMedia(media);
    expect(await fs.readFile(f.destination(source))).toEqual(bytes);
    const result = await loadImages({ media, workspaceOnly: true });
    expect(result).toMatchObject({ failedMediaCount: 0, images: [expect.any(Object)] });
    const promptOnly = await loadImages({ prompt: `Inspect ${source}` });
    expect(promptOnly.images).toHaveLength(0);
    const outside = path.join(f.gateway, "private.png");
    await fs.writeFile(outside, bytes);
    const rejected = await loadImages({ media: [{ path: outside, contentType: "image/png" }] });
    expect(rejected).toMatchObject({ images: [], failedMediaCount: 1 });
  });

  it("transfers 50 MiB without a Gateway workspace copy and preserves subsequent Harness edits", async () => {
    const data = Buffer.alloc(50 * 1024 * 1024, 0xa5);
    const source = await writeMedia("remote-cache/report.bin", data);
    const input = turn([{ path: source }]);
    const original = JSON.stringify(input);
    const note = await f.prepare(input, () => {});
    expect(note).toBe(`[media attached: ${f.destination(source)}]`);
    expect(digest(await fs.readFile(f.destination(source)))).toBe(digest(data));
    expect(await fs.readdir(f.gateway)).toEqual([]);
    expect(JSON.stringify(input)).toBe(original);
    const isPrivateInput = createStagedInputPathMatcher(await fsRoot(f.harness));
    expect(await isPrivateInput(path.relative(f.harness, f.destination(source)))).toBe(true);
    await fs.writeFile(f.destination(source), "Harness edit");
    expect(await f.prepare(input, () => {})).toBe(note);
    expect(await fs.readFile(f.destination(source), "utf8")).toBe("Harness edit");
  });

  it("retains an explicitly configured allowance above the ordinary staging limit", async () => {
    const source = await writeMedia("remote-cache/configured.bin", "");
    await fs.truncate(source, 51 * 1024 * 1024);
    await f.prepare(
      { ...turn([{ path: source }]), config: { agents: { defaults: { mediaMaxMb: 51 } } } },
      () => {},
    );
    expect((await fs.stat(f.destination(source))).size).toBe(51 * 1024 * 1024);
  });

  it("hydrates a managed video for a sandboxed remote turn without rewriting its recorded reference", async () => {
    const bytes = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");
    await writeMedia("inbound/input.mp4", bytes);
    const message = buildPersistedUserTurnMessage({
      text: "Inspect the video",
      media: [{ kind: "video", contentType: "video/mp4", url: "media://inbound/input.mp4" }],
    });
    const original = JSON.stringify(message);
    const provider = await materializeProviderContext({
      context: { systemPrompt: "system", messages: convertToLlm([message]), tools: [] },
      workspaceDir: f.gateway,
      sandbox: { root: f.harness, bridge: f.bridge },
      workspaceOnly: true,
    });
    expect(provider.messages[0]?.content).toContainEqual({
      type: "video",
      data: bytes.toString("base64"),
      mimeType: "video/mp4",
    });
    expect(JSON.stringify(message)).toBe(original);
  });

  it("uses canonical originals, deduplicates aliases, and separates sources with the same basename", async () => {
    const first = await writeMedia("inbound/report.txt", "original");
    const second = await writeMedia("remote-cache/report.txt", "other");
    const note = await prepareMedia([
      { path: "/stale/workspace/copy", url: "media://inbound/report.txt" },
      { path: first },
      { url: pathToFileURL(first).href },
      { path: second },
    ]);
    expect(note?.split("\n")).toEqual(
      [first, second].map((source) => `[media attached: ${f.destination(source)}]`),
    );
    expect(await fs.readFile(f.destination(first), "utf8")).toBe("original");
    expect(await fs.readFile(f.destination(second), "utf8")).toBe("other");
  });

  it.each([
    "outside",
    "symlink",
    "invalid-uri",
    "oversized",
    "unmarked-directory",
    "bad-marker",
    "non-file",
  ])("rejects unsafe staging: %s", async (kind) => {
    const existing = ["unmarked-directory", "bad-marker", "non-file"].includes(kind);
    let source = existing ? await writeMedia() : path.join(f.gateway, "secret.txt");
    if (!existing) {
      await fs.writeFile(source, "secret");
    }
    if (kind === "symlink") {
      const outside = source;
      source = path.join(getMediaDir(), "remote-cache", "escape.txt");
      await fs.symlink(outside, source);
    } else if (kind === "invalid-uri") {
      source = "media://inbound/nested%2Fsecret.txt";
    } else if (kind === "oversized") {
      source = await writeMedia("remote-cache/large.bin", "");
      await fs.truncate(source, 50 * 1024 * 1024 + 1);
    }
    const destination = f.destination(source);
    const markerPath = path.join(path.dirname(destination), ".gitignore");
    if (kind === "non-file") {
      await prepareMedia([{ path: source }]);
      await fs.unlink(destination);
      await fs.mkdir(destination);
    } else if (existing) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      if (kind === "bad-marker") {
        await fs.writeFile(markerPath, "user marker");
      }
    }
    f.create.mockClear();
    const media = existing ? { path: source } : { path: source, workspaceDir: f.gateway };
    await expect(prepareMedia([media])).rejects.toThrow();
    if (kind !== "non-file") {
      expect(f.create).not.toHaveBeenCalled();
    }
    if (!existing) {
      expect(await fs.readdir(f.harness)).toEqual([]);
    }
    if (kind === "bad-marker") {
      expect(await fs.readFile(markerPath, "utf8")).toBe("user marker");
    }
  });

  it("does not fetch HTTP references or invent source files for inline images", async () => {
    await expect(
      prepareMedia([{ url: "https://example.test/input" }, { kind: "image" }]),
    ).resolves.toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
  });

  it.each(["preparation", "command admission"])(
    "checks source authority after %s",
    async (stage) => {
      const source = await writeMedia();
      const preparing = stage === "preparation";
      let active = true;
      let creating = false;
      const admitted = vi.fn();
      const prepare = createWorkspaceAttachmentPreparer({
        remoteRoot: f.harness,
        createBridge: (assertCurrent) => {
          const session = createRemoteShellSandboxSession({
            buildCommand: ({ remoteCommand }) => ({
              argv: ["/bin/sh", "-c", remoteCommand],
              env: { ...process.env },
            }),
            assertCurrent() {
              assertCurrent();
              admitted();
            },
          });
          const bridge = preparing
            ? f.bridge
            : createBridge(f.gateway, f.harness, async ({ script, args = [], ...options }) => {
                const command = ["/bin/sh", "-c", script, "fixture", ...args];
                const result = await session.runCommand({
                  remoteCommand: buildRemoteCommand(command),
                  ...options,
                });
                if (creating) {
                  active = false;
                  admitted.mockClear();
                }
                return result;
              });
          return {
            readFile: bridge.readFile.bind(bridge),
            async stat(params) {
              const stat = await bridge.stat(params);
              if (preparing) {
                active = false;
              }
              return stat;
            },
            createFileExclusive(params) {
              creating = true;
              return preparing ? f.create(params) : bridge.createFileExclusive!(params);
            },
          };
        },
      });
      await expect(
        prepare(turn([{ path: source }]), () => {
          if (!active) {
            throw new Error("source closed");
          }
        }),
      ).rejects.toThrow("source closed");
      expect(admitted).not.toHaveBeenCalled();
      expect(await fs.readdir(f.harness)).toEqual([]);
    },
  );
});
