import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  declareAgentWorkspaceAccess,
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "../agents/workspace-access.js";
import { createReplyMediaPathNormalizer } from "../auto-reply/reply/reply-media-paths.js";
import { createDeferredCore } from "../shared/deferred.js";
import { buildOutboundMediaLoadOptions } from "./load-options.js";
import { resolveAgentScopedOutboundMediaAccess as resolveMediaAccess } from "./read-capability.js";
import { saveMediaBuffer } from "./store.js";
import { loadWebMediaRaw } from "./web-media.js";

vi.mock("../agents/sandbox/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/sandbox/context.js")>()),
  ensureSandboxWorkspaceForSession: vi.fn(async () => undefined),
}));
vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
  getLoadedChannelPlugin: () => undefined,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const harnessBytes = Buffer.from("Harness output");
let f: Awaited<ReturnType<typeof workspaceFixture>>;

async function workspaceFixture() {
  const root = await fs.realpath(tempDirs.make("outbound-workspace-"));
  const workspace = path.join(root, "gateway-workspace");
  const output = path.join(workspace, "output");
  const file = path.join(output, "report.txt");
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(file, "stale Gateway copy");
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "gateway-state"));
  const cfg = { agents: { entries: { writer: { workspace } } } };
  const reader = vi.fn<NonNullable<AgentWorkspaceAccess["outboundMedia"]>["readFile"]>(
    async (_file, maxBytes) => {
      if (harnessBytes.length > maxBytes) {
        throw new Error("Remote media exceeds maxBytes");
      }
      return Buffer.from(harnessBytes);
    },
  );
  const host: AgentWorkspaceAccess = {
    bridge: {
      readFile: vi
        .fn<AgentWorkspaceAccess["bridge"]["readFile"]>()
        .mockRejectedValue(new Error("Owner documents only")),
      stat: vi.fn(async () => null),
      writeFile: vi.fn(async () => {}),
    },
    outboundMedia: { localRoots: [output], readFile: reader },
  };
  const resolve = (overrides: Partial<Parameters<typeof resolveMediaAccess>[0]> = {}) =>
    resolveMediaAccess({ cfg, agentId: "writer", ...overrides });
  const load = (source = file, access = resolve(), maxBytes?: number) =>
    loadWebMediaRaw(source, buildOutboundMediaLoadOptions({ mediaAccess: access, maxBytes }));
  return {
    root,
    workspace,
    output,
    file,
    cfg,
    host,
    reader,
    resolve,
    load,
    normalizer: () =>
      createReplyMediaPathNormalizer({ cfg, agentId: "writer", workspaceDir: workspace }),
    bind: (access = host) => {
      const release = registerAgentWorkspaceAccess(workspace, access);
      onTestFinished(release);
      return release;
    },
  };
}
beforeEach(async () => {
  f = await workspaceFixture();
});
afterEach(() => {
  vi.unstubAllEnvs();
  expect(f.host.bridge.readFile).not.toHaveBeenCalled();
});

describe("registered workspace outbound media", () => {
  it("stages remote bytes from snapshotted roots without exposing documents or stale mirrors", async () => {
    const alias = path.join(f.root, "remote-output");
    const roots = [f.output, alias];
    f.host.outboundMedia!.localRoots = roots;
    const normalize = f.normalizer(); // Capture before the workspace service starts.
    f.bind();
    roots.push(f.workspace);
    const result = await normalize({ mediaUrl: "output/report.txt" });
    expect(await fs.readFile(result.mediaUrl!, "utf8")).toBe("Harness output");
    expect(await fs.readFile(f.file, "utf8")).toBe("stale Gateway copy");
    expect(f.reader).toHaveBeenCalledWith(f.file, expect.any(Number));
    const fallback = vi.fn(async () => Buffer.from("wrong local bytes"));
    const access = f.resolve({
      agentId: "other",
      workspaceDir: f.workspace,
      mediaAccess: { localRoots: [f.root], readFile: fallback },
    });
    expect((await f.load(path.join(alias, "report.txt"), access)).buffer).toEqual(harnessBytes);
    expect(fallback).not.toHaveBeenCalled();
    const document = path.join(f.workspace, "AGENTS.md");
    await fs.writeFile(document, "stale document");
    await expect(f.load(document)).rejects.toMatchObject({ code: "path-not-allowed" });
  });

  it("preserves managed and HTTP attachments after remote shutdown", async () => {
    f.bind()();
    const attachment = Buffer.from("Gateway attachment");
    const saved = await saveMediaBuffer(attachment, "text/plain", "outbound");
    const url = "https://example.com/report.txt";
    expect(await f.normalizer()({ mediaUrls: [f.file, saved.path, url] })).toMatchObject({
      mediaUrls: [saved.path, url],
    });
    expect(await fs.readFile(saved.path, "utf8")).toBe("Gateway attachment");
    expect((await f.load(saved.path)).buffer.toString()).toBe("Gateway attachment");
  });

  it("preserves local delivery for a stopped document-only binding", async () => {
    f.bind({ bridge: f.host.bridge })();
    expect((await f.load()).buffer.toString()).toBe("stale Gateway copy");
  });

  it("bounds remote output before loading", async () => {
    f.bind();
    await expect(f.load(f.file, f.resolve(), 4)).rejects.toThrow("Remote media exceeds maxBytes");
  });

  it("denies remote output for a blocked sender", async () => {
    f.bind();
    const access = f.resolve({
      cfg: { ...f.cfg, tools: { toolsBySender: { "id:blocked": { deny: ["read"] } } } },
      messageProvider: "requestchat",
      requesterSenderId: "blocked",
    });
    await expect(f.load(f.file, access)).rejects.toMatchObject({ code: "path-not-allowed" });
    expect(f.reader).not.toHaveBeenCalled();
  });

  it("never rebinds a reader captured before start", async () => {
    declareAgentWorkspaceAccess(f.workspace);
    const retained = f.resolve();
    f.bind();
    await expect(retained.readFile!(f.file)).rejects.toThrow("stopped or not ready");
    expect(f.reader).not.toHaveBeenCalled();
  });

  it("rejects an in-flight read after rebinding", async () => {
    const pending = createDeferredCore<Buffer>();
    const release = f.bind();
    const retained = f.resolve();
    f.reader.mockReturnValueOnce(pending.promise);
    const rejected = expect(retained.readFile!(f.file)).rejects.toThrow("stopped or not ready");
    release();
    f.bind();
    pending.resolve(Buffer.from("late output"));
    await rejected;
    await expect(retained.readFile!(f.file)).rejects.toThrow("stopped or not ready");
    expect(f.reader).toHaveBeenCalledTimes(1);
    await expect(f.resolve().readFile!(f.file)).resolves.toEqual(harnessBytes);
  });

  it.each([false, true])(
    "isolates remote aliases from granted siblings (workspaceOnly=%s)",
    async (workspaceOnly) => {
      const generated = path.join(f.root, "generated", "report.txt");
      const alias = path.join(f.root, "alias", "report.txt");
      await fs.mkdir(path.dirname(generated));
      await fs.writeFile(generated, "local generated output");
      await fs.symlink(f.output, path.dirname(alias), "dir");
      const release = f.bind();
      const access = f.resolve({
        cfg: { ...f.cfg, tools: { fs: { workspaceOnly } } },
        mediaAccess: { localRoots: [f.root] },
      });
      expect((await f.load(generated, access)).buffer.toString()).toBe("local generated output");
      expect((await f.load(f.file, access)).buffer.toString()).toBe("Harness output");
      await expect(f.load(alias, access)).rejects.toMatchObject({ code: "path-not-allowed" });
      release();
      expect((await f.load(generated, access)).buffer.toString()).toBe("local generated output");
      await expect(f.load(f.file, access)).rejects.toThrow("stopped or not ready");
    },
  );

  it.each(["overlapping", "session"] as const)("preserves the explicit %s reader", async (kind) => {
    f.bind();
    const session = path.join(f.root, "session-sandbox");
    const roots = kind === "overlapping" ? [f.workspace, "/workspace"] : [session];
    const bytes = Buffer.from("current sandbox output");
    const readFile = vi.fn(async () => bytes);
    const access = f.resolve({
      sessionWorkspaceDir: kind === "session" ? session : undefined,
      workspaceMediaAccess: {
        localRoots: roots,
        readFile,
        workspaceDir: kind === "overlapping" ? f.workspace : undefined,
      },
    });
    const relative = kind === "session" ? "report.txt" : "output/report.txt";
    for (const root of roots) {
      expect((await f.load(path.join(root, relative), access)).buffer.toString()).toBe(
        "current sandbox output",
      );
    }
    expect(f.reader).not.toHaveBeenCalled();
  });
});
