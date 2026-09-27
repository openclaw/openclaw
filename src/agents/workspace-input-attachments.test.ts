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

beforeEach(async () => {
  root = await fs.realpath(dirs.make("openclaw-workspace-inputs-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  await fs.mkdir(path.join(getMediaDir(), "inbound"), { recursive: true });
  await fs.mkdir(path.join(getMediaDir(), "remote-cache"));
});
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const gateway = path.join(root, "gateway");
  const harness = path.join(root, "harness");
  await fs.mkdir(gateway);
  await fs.mkdir(harness);
  const bridge = createRemoteShellSandboxFsBridge({
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
      runRemoteShellScript: createLocalRemoteShellScriptRunner(),
    },
  });
  const create = vi.fn(bridge.createFileExclusive!.bind(bridge));
  const prepare = createWorkspaceAttachmentPreparer({
    createBridge: () => ({
      readFile: bridge.readFile.bind(bridge),
      stat: bridge.stat.bind(bridge),
      createFileExclusive: create,
    }),
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

// These fixtures run the Linux remote host locally (including GNU stat).
const describeLinux = describe.runIf(process.platform === "linux");
describeLinux("workspace attachment adapter with the real remote-shell bridge", () => {
  it.each(["inbound", "remote-cache"])(
    "keeps %s images readable on Gateway and transfers their originals without a local workspace copy",
    async (directory) => {
      const f = await fixture();
      const source = path.join(getMediaDir(), directory, "input.png");
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
        "base64",
      );
      await fs.writeFile(source, bytes);
      const media = [{ path: source, contentType: "image/png" }];
      const ctx = { media };
      const release = registerAgentWorkspaceAccess(f.gateway, {
        bridge: f.bridge,
        prepareTurnAttachments: f.prepare,
      });
      try {
        await stageSandboxMedia({
          ctx,
          sessionCtx: ctx,
          cfg: {},
          sessionKey: "agent:main:test",
          workspaceDir: f.gateway,
        });
        expect(ctx.media).toBe(media);
        expect(await fs.readdir(f.gateway)).toEqual([]);
        await f.prepare(turn(media), () => {});
        expect(await fs.readFile(f.destination(source))).toEqual(bytes);
        const result = await detectAndLoadPromptImages({
          prompt: "Inspect the attachment",
          media,
          workspaceDir: f.gateway,
          model: { input: ["text", "image"] },
          workspaceOnly: true,
          sandbox: { root: f.harness, bridge: f.bridge },
        });
        expect(result.failedMediaCount).toBe(0);
        expect(result.images).toHaveLength(1);
        const promptOnly = await detectAndLoadPromptImages({
          prompt: `Inspect ${source}`,
          workspaceDir: f.gateway,
          model: { input: ["text", "image"] },
          sandbox: { root: f.harness, bridge: f.bridge },
        });
        expect(promptOnly.images).toHaveLength(0);
        const outside = path.join(f.gateway, "private.png");
        await fs.writeFile(outside, bytes);
        const rejected = await detectAndLoadPromptImages({
          prompt: "Inspect the attachment",
          media: [{ path: outside, contentType: "image/png" }],
          workspaceDir: f.gateway,
          model: { input: ["text", "image"] },
          sandbox: { root: f.harness, bridge: f.bridge },
        });
        expect(rejected.images).toHaveLength(0);
        expect(rejected.failedMediaCount).toBe(1);
      } finally {
        release();
      }
    },
  );

  it.each([17, 50])(
    "transfers %i MiB without a Gateway workspace copy and preserves subsequent Harness edits",
    async (size) => {
      const f = await fixture();
      const source = path.join(getMediaDir(), "remote-cache", "report.bin");
      const data = Buffer.alloc(size * 1024 * 1024, 0xa5);
      await fs.writeFile(source, data);
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
    },
  );

  it("retains an explicitly configured allowance above the ordinary staging limit", async () => {
    const f = await fixture();
    const source = path.join(getMediaDir(), "remote-cache", "configured.bin");
    await fs.writeFile(source, "");
    await fs.truncate(source, 51 * 1024 * 1024);
    await f.prepare(
      { ...turn([{ path: source }]), config: { agents: { defaults: { mediaMaxMb: 51 } } } },
      () => {},
    );
    expect((await fs.stat(f.destination(source))).size).toBe(51 * 1024 * 1024);
  });

  it("hydrates a managed video for a sandboxed remote turn without rewriting its recorded reference", async () => {
    const f = await fixture();
    const bytes = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");
    await fs.writeFile(path.join(getMediaDir(), "inbound", "input.mp4"), bytes);
    const message = buildPersistedUserTurnMessage({
      text: "Inspect the video",
      media: [{ kind: "video", contentType: "video/mp4", url: "media://inbound/input.mp4" }],
    });
    const original = JSON.stringify(message);
    const release = registerAgentWorkspaceAccess(f.gateway, {
      bridge: f.bridge,
      prepareTurnAttachments: f.prepare,
    });
    try {
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
    } finally {
      release();
    }
  });

  it("uses canonical originals, deduplicates aliases, and separates sources with the same basename", async () => {
    const f = await fixture();
    const first = path.join(getMediaDir(), "inbound", "report.txt");
    const second = path.join(getMediaDir(), "remote-cache", "report.txt");
    await fs.writeFile(first, "original");
    await fs.writeFile(second, "other");
    const note = await f.prepare(
      turn([
        { path: "/stale/workspace/copy", url: "media://inbound/report.txt" },
        { path: first },
        { url: pathToFileURL(first).href },
        { path: second },
      ]),
      () => {},
    );
    expect(note?.split("\n")).toEqual(
      [first, second].map((source) => `[media attached: ${f.destination(source)}]`),
    );
    expect(await fs.readFile(f.destination(first), "utf8")).toBe("original");
    expect(await fs.readFile(f.destination(second), "utf8")).toBe("other");
    expect(f.create).toHaveBeenCalledTimes(4);
  });

  it.each(["outside", "symlink", "invalid-uri", "oversized"])(
    "rejects %s input before any remote mutation",
    async (kind) => {
      const f = await fixture();
      const outside = path.join(f.gateway, "secret.txt");
      await fs.writeFile(outside, "secret");
      let source = outside;
      if (kind === "symlink") {
        source = path.join(getMediaDir(), "remote-cache", "escape.txt");
        await fs.symlink(outside, source);
      } else if (kind === "invalid-uri") {
        source = "media://inbound/nested%2Fsecret.txt";
      } else if (kind === "oversized") {
        source = path.join(getMediaDir(), "remote-cache", "large.bin");
        await fs.writeFile(source, "");
        await fs.truncate(source, 50 * 1024 * 1024 + 1);
      }
      await expect(
        f.prepare(turn([{ path: source, workspaceDir: f.gateway }]), () => {}),
      ).rejects.toThrow();
      expect(f.create).not.toHaveBeenCalled();
      expect(await fs.readdir(f.harness)).toEqual([]);
    },
  );

  it.each(["unmarked-directory", "bad-marker", "non-file"])(
    "does not overwrite an existing %s",
    async (kind) => {
      const f = await fixture();
      const source = path.join(getMediaDir(), "inbound", "report.txt");
      await fs.writeFile(source, "input");
      const destination = f.destination(source);
      if (kind === "non-file") {
        await f.prepare(turn([{ path: source }]), () => {});
        await fs.unlink(destination);
        await fs.mkdir(destination);
      } else {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        if (kind === "bad-marker") {
          await fs.writeFile(path.join(path.dirname(destination), ".gitignore"), "user marker");
        }
      }
      f.create.mockClear();
      await expect(f.prepare(turn([{ path: source }]), () => {})).rejects.toThrow();
      if (kind !== "non-file") {
        expect(f.create).not.toHaveBeenCalled();
      }
      if (kind === "bad-marker") {
        expect(await fs.readFile(path.join(path.dirname(destination), ".gitignore"), "utf8")).toBe(
          "user marker",
        );
      }
    },
  );

  it("stops between preparation and mutation when the source authority closes", async () => {
    const f = await fixture();
    const source = path.join(getMediaDir(), "inbound", "report.txt");
    await fs.writeFile(source, "input");
    let active = true;
    const prepare = createWorkspaceAttachmentPreparer({
      remoteRoot: f.harness,
      createBridge: () => ({
        readFile: f.bridge.readFile.bind(f.bridge),
        createFileExclusive: f.create,
        stat: async (params) => {
          const stat = await f.bridge.stat(params);
          active = false;
          return stat;
        },
      }),
    });
    await expect(
      prepare(turn([{ path: source }]), () => {
        if (!active) {
          throw new Error("source closed");
        }
      }),
    ).rejects.toThrow("source closed");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("does not fetch HTTP references or invent source files for inline images", async () => {
    const f = await fixture();
    await expect(
      f.prepare(turn([{ url: "https://example.test/input" }, { kind: "image" }]), () => {}),
    ).resolves.toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("checks message authority at command admission after in-flight path validation", async () => {
    const f = await fixture();
    const source = path.join(getMediaDir(), "inbound", "report.txt");
    await fs.writeFile(source, "input");
    let active = true;
    let creating = false;
    let validationCompleted = false;
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
        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: {
            workspaceDir: f.gateway,
            agentWorkspaceDir: f.gateway,
            workspaceAccess: "rw",
            containerName: "fixture",
            containerWorkdir: f.harness,
            docker: {},
          },
          runtime: {
            remoteWorkspaceDir: f.harness,
            remoteAgentWorkspaceDir: f.harness,
            async runRemoteShellScript({ script, args = [], ...options }) {
              const result = await session.runCommand({
                remoteCommand: buildRemoteCommand(["/bin/sh", "-c", script, "fixture", ...args]),
                ...options,
              });
              if (creating) {
                validationCompleted = true;
                active = false;
                admitted.mockClear();
              }
              return result;
            },
          },
        });
        return {
          readFile: bridge.readFile.bind(bridge),
          stat: bridge.stat.bind(bridge),
          createFileExclusive(params) {
            creating = true;
            return bridge.createFileExclusive!(params);
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
    expect(validationCompleted).toBe(true);
    expect(admitted).not.toHaveBeenCalled();
    expect(await fs.readdir(f.harness)).toEqual([]);
  });
});
