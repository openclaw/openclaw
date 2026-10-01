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
  cfg = { agents: { list: [{ id: "writer", workspace: workspaceDir }] } };
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

describe("registered workspace outbound media", () => {
  it.each(["absolute", "relative"])(
    "stages Harness bytes for an ordinary %s reply path without using the document bridge",
    async (kind) => {
      // Normalizers may be created before service start; access is acquired per source.
      const normalize = normalizer();
      bind();
      const filePath = path.join(outputRoot, "report.txt");
      const result = await normalize({
        mediaUrl: kind === "absolute" ? filePath : "output/report.txt",
      });
      expect(result.mediaUrl).toBeDefined();
      expect(result.mediaUrl).not.toBe(filePath);
      expect(await fs.readFile(result.mediaUrl!, "utf8")).toBe("Harness output");
      expect(await fs.readFile(filePath, "utf8")).toBe("stale Gateway copy");
      expect(remoteRead).toHaveBeenCalledWith(filePath, expect.any(Number));
      expect(host.bridge.readFile).not.toHaveBeenCalled();
    },
  );

  it.each(["not ready", "stopped"])(
    "fails workspace output when %s, while preserving managed Gateway media and HTTP references",
    async (state) => {
      if (state === "not ready") {
        declareAgentWorkspaceAccess(workspaceDir);
      } else {
        bind()();
      }
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
      const loaded = await loadWebMediaRaw(
        saved.path,
        buildOutboundMediaLoadOptions({ mediaAccess: resolveAccess() }),
      );
      expect(loaded.buffer.toString()).toBe("Gateway attachment");
    },
  );

  it.each(["active", "stopped"])(
    "preserves local attachment delivery for a %s document-only binding",
    async (state) => {
      const release = bind({ bridge: host.bridge });
      if (state === "stopped") {
        release();
      }
      const filePath = path.join(outputRoot, "report.txt");
      const loaded = await loadWebMediaRaw(
        filePath,
        buildOutboundMediaLoadOptions({ mediaAccess: resolveAccess() }),
      );
      expect(loaded.buffer.toString()).toBe("stale Gateway copy");
      expect(remoteRead).not.toHaveBeenCalled();
      expect(host.bridge.readFile).not.toHaveBeenCalled();
    },
  );

  it("forwards the loader's source byte limit and propagates remote failure without local fallback", async () => {
    bind();
    const filePath = path.join(outputRoot, "report.txt");
    await expect(
      loadWebMediaRaw(
        filePath,
        buildOutboundMediaLoadOptions({ maxBytes: 4, mediaAccess: resolveAccess() }),
      ),
    ).rejects.toThrow("Remote media exceeds maxBytes");
    expect(remoteRead).toHaveBeenCalledWith(filePath, 4);
  });

  it("revokes retained readers across service replacement and discards an in-flight result", async () => {
    const pending = createDeferredCore<Buffer>();
    remoteRead.mockReturnValueOnce(pending.promise);
    const release = bind();
    const retained = resolveAccess();
    const filePath = path.join(outputRoot, "report.txt");
    const read = retained.readFile!(filePath);
    const rejected = expect(read).rejects.toThrow("stopped or not ready");
    release();
    bind();
    pending.resolve(Buffer.from("late output"));
    await rejected;
    await expect(retained.readFile!(filePath)).rejects.toThrow("stopped or not ready");
    expect(remoteRead).toHaveBeenCalledTimes(1);
    await expect(resolveAccess().readFile!(filePath)).resolves.toEqual(
      Buffer.from("Harness output"),
    );
  });

  it("keeps pre-start captures offline instead of adopting a later registration", async () => {
    declareAgentWorkspaceAccess(workspaceDir);
    const retained = resolveAccess();
    bind();
    await expect(retained.readFile!(path.join(outputRoot, "report.txt"))).rejects.toThrow(
      "stopped or not ready",
    );
    expect(remoteRead).not.toHaveBeenCalled();
  });

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
    await expect(
      loadWebMediaRaw(
        path.join(workspaceDir, "AGENTS.md"),
        buildOutboundMediaLoadOptions({ mediaAccess: access }),
      ),
    ).rejects.toMatchObject({ code: "path-not-allowed" });
  });

  it("keeps sender read policy ahead of registered output access", async () => {
    bind();
    const access = resolveAgentScopedOutboundMediaAccess({
      cfg: {
        ...cfg,
        tools: { toolsBySender: { "id:blocked": { deny: ["read"] } } },
      },
      agentId: "writer",
      messageProvider: "requestchat",
      requesterSenderId: "blocked",
    });
    await expect(
      loadWebMediaRaw(
        path.join(outputRoot, "report.txt"),
        buildOutboundMediaLoadOptions({ mediaAccess: access }),
      ),
    ).rejects.toMatchObject({ code: "path-not-allowed" });
    expect(remoteRead).not.toHaveBeenCalled();
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
      const load = (filePath: string) =>
        loadWebMediaRaw(filePath, buildOutboundMediaLoadOptions({ mediaAccess: access }));
      expect((await load(generated)).buffer.toString()).toBe("local generated output");
      expect((await load(path.join(outputRoot, "report.txt"))).buffer.toString()).toBe(
        "Harness output",
      );
      await expect(load(path.join(parent, "alias", "report.txt"))).rejects.toMatchObject({
        code: "path-not-allowed",
      });
      release();
      expect((await load(generated)).buffer.toString()).toBe("local generated output");
      await expect(load(path.join(outputRoot, "report.txt"))).rejects.toThrow(
        "stopped or not ready",
      );
    },
  );

  it.each(["active", "stopped"])(
    "preserves the rw sandbox reader for overlapping host and container roots (%s registration)",
    async (state) => {
      const release = bind();
      if (state === "stopped") {
        release();
      }
      // rw sandboxes use the agent workspace as their host root.
      const containerRoot = "/workspace";
      const readSandbox = vi.fn(async () => Buffer.from("current sandbox output"));
      const access = resolveAgentScopedOutboundMediaAccess({
        cfg,
        agentId: "writer",
        workspaceMediaAccess: {
          localRoots: [workspaceDir, containerRoot],
          readFile: readSandbox,
          workspaceDir,
        },
      });
      for (const root of [workspaceDir, containerRoot]) {
        const filePath = path.join(root, "output/report.txt");
        const loaded = await loadWebMediaRaw(
          filePath,
          buildOutboundMediaLoadOptions({ mediaAccess: access }),
        );
        expect(loaded.buffer.toString()).toBe("current sandbox output");
      }
      expect(readSandbox).toHaveBeenCalledTimes(2);
      expect(remoteRead).not.toHaveBeenCalled();
    },
  );

  it("preserves an explicit session workspace reader outside the registered agent workspace", async () => {
    bind();
    const sessionRoot = path.join(path.dirname(workspaceDir), "session-sandbox");
    const readSession = vi.fn(async () => Buffer.from("session bytes"));
    const access = resolveAgentScopedOutboundMediaAccess({
      cfg,
      agentId: "writer",
      sessionWorkspaceDir: sessionRoot,
      workspaceMediaAccess: { localRoots: [sessionRoot], readFile: readSession },
    });
    await expect(access.readFile!(path.join(sessionRoot, "report.txt"))).resolves.toEqual(
      Buffer.from("session bytes"),
    );
    expect(remoteRead).not.toHaveBeenCalled();
  });
});
