import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  declareAgentWorkspaceAccess,
  getAgentWorkspaceAccess,
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "../agents/workspace-access.js";
import { createReplyMediaPathNormalizer } from "../auto-reply/reply/reply-media-paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readOutboundMediaFile } from "./bounded-read-file.js";
import { buildOutboundMediaLoadOptions } from "./load-options.js";
import { resolveAgentScopedOutboundMediaAccess } from "./read-capability.js";
import { saveMediaBuffer } from "./store.js";
import { loadWebMediaRaw } from "./web-media.js";

vi.mock("../agents/sandbox.js", () => ({
  ensureSandboxWorkspaceForSession: vi.fn(async () => undefined),
}));
vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const releases: (() => void)[] = [];
let workspaceDir: string;
let outputRoot: string;
let cfg: OpenClawConfig;
let host: AgentWorkspaceAccess;
let remoteRead: ReturnType<
  typeof vi.fn<NonNullable<AgentWorkspaceAccess["outboundMedia"]>["readFile"]>
>;

beforeEach(async () => {
  const root = await fs.realpath(tempDirs.make("outbound-workspace-"));
  workspaceDir = path.join(root, "gateway-workspace");
  outputRoot = path.join(workspaceDir, "output");
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(outputRoot, "report.txt"), "stale Gateway copy");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "gateway-state"));
  cfg = { agents: { entries: { writer: { workspace: workspaceDir } } } };
  remoteRead = vi.fn(async (_filePath, maxBytes) => {
    const bytes = Buffer.from("Harness output");
    if (bytes.length > maxBytes) {
      throw new Error("Remote media exceeds maxBytes");
    }
    return bytes;
  });
  host = {
    bridge: {
      readFile: vi.fn(async () => {
        throw new Error("Owner documents only");
      }),
      stat: vi.fn(async () => null),
      writeFile: vi.fn(async () => {}),
    },
    outboundMedia: { localRoots: [outputRoot], readFile: remoteRead },
  };
});

afterEach(() => {
  for (const release of releases.splice(0)) {
    release();
  }
  vi.unstubAllEnvs();
});

function bind(access = host) {
  const release = registerAgentWorkspaceAccess(workspaceDir, access);
  releases.push(release);
  return release;
}

function resolveAccess() {
  return resolveAgentScopedOutboundMediaAccess({ cfg, agentId: "writer" });
}

function normalizer() {
  return createReplyMediaPathNormalizer({ cfg, agentId: "writer", workspaceDir });
}

function load(filePath: string, mediaAccess = resolveAccess(), maxBytes?: number) {
  return loadWebMediaRaw(filePath, buildOutboundMediaLoadOptions({ mediaAccess, maxBytes }));
}

describe("registered workspace outbound media", () => {
  it("stages Harness bytes for a relative reply path without using the document bridge", async () => {
    // Normalizers may be created before service start; access is acquired per source.
    const normalize = normalizer();
    bind();
    const filePath = path.join(outputRoot, "report.txt");
    const result = await normalize({
      mediaUrl: "output/report.txt",
    });
    expect(result.mediaUrl).toBeDefined();
    expect(result.mediaUrl).not.toBe(filePath);
    expect(await fs.readFile(result.mediaUrl!, "utf8")).toBe("Harness output");
    expect(await fs.readFile(filePath, "utf8")).toBe("stale Gateway copy");
    expect(remoteRead).toHaveBeenCalledWith(filePath, expect.any(Number));
    expect(host.bridge.readFile).not.toHaveBeenCalled();
  });

  it("fails stopped workspace output while preserving managed Gateway media and HTTP references", async () => {
    bind()();
    const saved = await saveMediaBuffer(
      Buffer.from("Gateway attachment"),
      "text/plain",
      "outbound",
    );
    const url = "https://example.com/report.txt";
    const result = await normalizer()({
      mediaUrls: [path.join(outputRoot, "report.txt"), saved.path, url],
    });
    expect(result.mediaUrls).toEqual([saved.path, url]);
    expect(await fs.readFile(saved.path, "utf8")).toBe("Gateway attachment");
    expect(remoteRead).not.toHaveBeenCalled();
    expect(host.bridge.readFile).not.toHaveBeenCalled();
    // Queue/channel loaders also remain usable without invoking the offline host.
    const loaded = await load(saved.path);
    expect(loaded.buffer.toString()).toBe("Gateway attachment");
  });

  it("preserves local attachment delivery for a stopped document-only binding", async () => {
    bind({ bridge: host.bridge })();
    const filePath = path.join(outputRoot, "report.txt");
    const loaded = await load(filePath);
    expect(loaded.buffer.toString()).toBe("stale Gateway copy");
    expect(remoteRead).not.toHaveBeenCalled();
    expect(host.bridge.readFile).not.toHaveBeenCalled();
  });

  it.each(["byte limit", "sender policy"] as const)(
    "rejects remote output at the %s boundary",
    async (boundary) => {
      bind();
      const filePath = path.join(outputRoot, "report.txt");
      const access =
        boundary === "byte limit"
          ? resolveAccess()
          : resolveAgentScopedOutboundMediaAccess({
              cfg: { ...cfg, tools: { toolsBySender: { "id:blocked": { deny: ["read"] } } } },
              agentId: "writer",
              messageProvider: "requestchat",
              requesterSenderId: "blocked",
            });
      const result = load(filePath, access, boundary === "byte limit" ? 4 : undefined);
      if (boundary === "byte limit") {
        await expect(result).rejects.toThrow("Remote media exceeds maxBytes");
        expect(remoteRead).toHaveBeenCalledWith(filePath, 4);
      } else {
        await expect(result).rejects.toMatchObject({ code: "path-not-allowed" });
        expect(remoteRead).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["pre-start", "in-flight"] as const)(
    "never rebinds a retained %s reader",
    async (phase) => {
      const pending = createDeferredCore<Buffer>();
      const filePath = path.join(outputRoot, "report.txt");
      if (phase === "pre-start") {
        declareAgentWorkspaceAccess(workspaceDir);
      }
      const release = phase === "in-flight" ? bind() : undefined;
      const retained = resolveAccess();
      if (release) {
        remoteRead.mockReturnValueOnce(pending.promise);
        const rejected = expect(retained.readFile!(filePath)).rejects.toThrow(
          "stopped or not ready",
        );
        release();
        bind();
        pending.resolve(Buffer.from("late output"));
        await rejected;
      } else {
        bind();
      }
      await expect(retained.readFile!(filePath)).rejects.toThrow("stopped or not ready");
      if (phase === "in-flight") {
        expect(remoteRead).toHaveBeenCalledTimes(1);
        await expect(resolveAccess().readFile!(filePath)).resolves.toEqual(
          Buffer.from("Harness output"),
        );
      } else {
        expect(remoteRead).not.toHaveBeenCalled();
      }
    },
  );

  it("snapshots outbound roots and honors remote aliases without expanding document access", async () => {
    const aliasRoot = path.join(path.dirname(workspaceDir), "remote-output");
    const roots = [outputRoot, aliasRoot];
    host.outboundMedia!.localRoots = roots;
    bind();
    roots.push(workspaceDir);
    expect(getAgentWorkspaceAccess(workspaceDir)!.outboundMedia!.localRoots).toEqual([
      outputRoot,
      aliasRoot,
    ]);
    const access = resolveAccess();
    expect(access.localRoots).not.toContain(workspaceDir);
    await expect(
      readOutboundMediaFile(access.readFile!, path.join(aliasRoot, "report.txt"), { maxBytes: 20 }),
    ).resolves.toEqual(Buffer.from("Harness output"));
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "stale document");
    await expect(load(path.join(workspaceDir, "AGENTS.md"), access)).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });

  it("routes the selected workspace instead of another agent or caller-local fallback", async () => {
    bind();
    const fallback = vi.fn(async () => Buffer.from("wrong local bytes"));
    const access = resolveAgentScopedOutboundMediaAccess({
      cfg,
      agentId: "other",
      workspaceDir,
      mediaAccess: { localRoots: [path.dirname(workspaceDir)], readFile: fallback },
    });
    expect(access.localRoots).toContain(path.dirname(workspaceDir));
    await expect(access.readFile!(path.join(outputRoot, "report.txt"))).resolves.toEqual(
      Buffer.from("Harness output"),
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves granted sibling files and rejects stale workspace aliases (workspaceOnly=%s)",
    async (workspaceOnly) => {
      const parent = path.dirname(workspaceDir);
      const generated = path.join(parent, "generated", "report.txt");
      await fs.mkdir(path.dirname(generated));
      await fs.writeFile(generated, "local generated output");
      await fs.symlink(outputRoot, path.join(parent, "alias"), "dir");
      const release = bind();
      const access = resolveAgentScopedOutboundMediaAccess({
        cfg: { ...cfg, tools: { fs: { workspaceOnly } } },
        agentId: "writer",
        mediaAccess: { localRoots: [parent] },
      });
      expect((await load(generated, access)).buffer.toString()).toBe("local generated output");
      expect((await load(path.join(outputRoot, "report.txt"), access)).buffer.toString()).toBe(
        "Harness output",
      );
      await expect(load(path.join(parent, "alias", "report.txt"), access)).rejects.toMatchObject({
        code: "path-not-allowed",
      });
      release();
      expect((await load(generated, access)).buffer.toString()).toBe("local generated output");
      await expect(load(path.join(outputRoot, "report.txt"), access)).rejects.toThrow(
        "stopped or not ready",
      );
    },
  );

  it.each(["overlapping", "session"] as const)(
    "preserves the explicit %s workspace reader",
    async (kind) => {
      bind();
      // rw sandboxes use the agent workspace as their host root.
      const sessionRoot = path.join(path.dirname(workspaceDir), "session-sandbox");
      const localRoots = kind === "overlapping" ? [workspaceDir, "/workspace"] : [sessionRoot];
      const bytes = Buffer.from(
        kind === "overlapping" ? "current sandbox output" : "session bytes",
      );
      const readSandbox = vi.fn(async () => bytes);
      const access = resolveAgentScopedOutboundMediaAccess({
        cfg,
        agentId: "writer",
        ...(kind === "session" ? { sessionWorkspaceDir: sessionRoot } : {}),
        workspaceMediaAccess: {
          localRoots,
          readFile: readSandbox,
          ...(kind === "overlapping" ? { workspaceDir } : {}),
        },
      });
      if (kind === "session") {
        await expect(access.readFile!(path.join(sessionRoot, "report.txt"))).resolves.toEqual(
          bytes,
        );
      } else {
        for (const root of localRoots) {
          const loaded = await load(path.join(root, "output/report.txt"), access);
          expect(loaded.buffer.toString()).toBe("current sandbox output");
        }
        expect(readSandbox).toHaveBeenCalledTimes(2);
      }
      expect(remoteRead).not.toHaveBeenCalled();
    },
  );
});
