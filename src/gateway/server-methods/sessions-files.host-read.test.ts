import "./sessions-files.mocks.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../../agents/sandbox/shared.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  assistantToolCall,
  createSessionFilesHandlerInvoker,
  createSessionFilesClient,
  createSessionFileDownloadClient,
  createVisibleMessagesMock,
  expectError,
  expectOkPayload,
  hashContent,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";
import * as workspaceFs from "./workspace-fs.js";

const { sessionFilesMocks } = await import("./sessions-files.mocks.test-support.js");
const hoisted = { ...sessionFilesMocks, execOpenPath: vi.fn() };

const sessionKey = "agent:main:main";
const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const outsideDirs = useAutoCleanupTempDirTracker(afterEach);
function outsideFile(content?: string) {
  const file = path.join(outsideDirs.make("session-files-outside-"), "outside.txt");
  if (content !== undefined) {
    fs.writeFileSync(file, content, "utf8");
  }
  return file;
}
const outsideBoundary = { type: "session_file_not_found", reason: "outside_session_boundary" };
const mockVisibleMessages = createVisibleMessagesMock(hoisted.readDelta);

let workspaceRoot: string;
beforeEach(() => {
  workspaceRoot = prepareSessionFilesTest(hoisted, mockVisibleMessages);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  removeWorkspaceFixture(workspaceRoot);
});

function prepareHostFileRead(
  overrides: Partial<InternalSessionEntry> = {},
  inputCfg: OpenClawConfig = {},
) {
  const cfg: OpenClawConfig = {
    ...inputCfg,
    agents: {
      ...inputCfg.agents,
      defaults: {
        ...inputCfg.agents?.defaults,
        sandbox: {
          ...inputCfg.agents?.defaults?.sandbox,
          workspaceRoot: outsideDirs.make("session-file-sandboxes-"),
        },
      },
    },
  };
  const entry: InternalSessionEntry = {
    sessionId: "sess-main",
    updatedAt: 1,
    sessionFile: "sess-main.jsonl",
    spawnedCwd: workspaceRoot,
    ...overrides,
  };
  const runtime = resolveSandboxRuntimeStatus({
    cfg,
    agentId: "main",
    sessionKey,
    preparedSessionEntry: entry,
  });
  const sandbox = resolveSandboxConfigForAgent(cfg, "main");
  if (runtime.sandboxed && sandbox.workspaceAccess === "none") {
    const layout = resolveSandboxWorkspaceLayoutPaths({
      cfg: runtime.sandboxRequired
        ? { ...sandbox, scope: "agent", workspaceAccess: runtime.workspaceAccess }
        : sandbox,
      agentId: "main",
      rawSessionKey: sessionKey,
      isolationSubject: runtime.isolationSubject,
      workspaceDir: workspaceRoot,
    });
    fs.mkdirSync(path.join(layout.workspaceDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(layout.workspaceDir, "src/readme.md"), "# Read me\n");
  }
  hoisted.loadSessionEntry.mockReturnValue({
    agentId: "main",
    canonicalKey: sessionKey,
    cfg,
    storePath: path.join(workspaceRoot, ".sessions.json"),
    entry,
  });
  const context = {
    getRuntimeConfig: () => cfg,
    workerSessionPlacementService: {
      getMany: () => new Map(),
      prepareRuntimeRefresh: async () => ({
        placement: undefined,
        move: undefined,
        pendingResult: undefined,
        assertCurrent: () => {},
        release: () => {},
      }),
    },
  } satisfies Pick<GatewayRequestContext, "getRuntimeConfig" | "workerSessionPlacementService">;
  const options: Pick<GatewayRequestHandlerOptions, "withSessionTurnAuthority"> = {
    withSessionTurnAuthority: async (_target, consume) => consume(entry),
  };
  setRuntimeConfigSnapshot(cfg);
  return {
    context,
    options,
    entry,
    files: createSessionFilesClient(invoke, () => ({ sessionKey, context, options })),
  };
}

it("downloads original binary bytes beyond preview limits with safe HTTP metadata and ranges", async () => {
  using connection = createSessionFileDownloadClient();
  const fixture = prepareHostFileRead({ permissionMode: "read-only" });
  const filename = "résumé original.zip";
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 17, 0xff);
  bytes.write("PK\x03\x04", "binary");
  fs.writeFileSync(path.join(workspaceRoot, filename), bytes);
  hoisted.loadSessionEntry.mockClear();
  const download = await fixture.files.ok("download", filename, undefined, connection);
  expect(hoisted.loadSessionEntry).toHaveBeenCalledOnce();
  expect(download).toMatchObject({ filename, mimeType: "application/zip" });
  const fetched = await connection.fetch(download.url);
  expect(fetched.response.statusCode).toBe(200);
  expect(Buffer.from(fetched.body as Uint8Array).equals(bytes)).toBe(true);
  expect(fetched.response.getHeader("content-disposition")).toContain("attachment;");
  expect(fetched.response.getHeader("content-disposition")).toContain(
    "filename*=UTF-8''r%C3%A9sum%C3%A9%20original.zip",
  );
  expect(fetched.response.getHeader("content-type")).toBe(download.mimeType);
  expect(fetched.response.getHeader("cache-control")).toBe("private, no-store");
  const head = await connection.fetch(download.url, "HEAD");
  expect(head.body).toBeUndefined();
  expect(head.response.getHeader("content-length")).toBe(String(bytes.length));
  const range = await connection.fetch(download.url, "GET", {
    range: "bytes=524280-524300",
  });
  expect(range.response.statusCode).toBe(206);
  expect(Buffer.from(range.body as Uint8Array)).toEqual(bytes.subarray(524280, 524301));
  using other = createSessionFileDownloadClient();
  expect((await other.fetch(download.url)).response.statusCode).toBe(404);
  fs.writeFileSync(path.join(workspaceRoot, filename), "replacement");
  expect((await connection.fetch(download.url)).response.statusCode).toBe(404);
});

it("rejects workspace escapes and links before granting downloads", async () => {
  using connection = createSessionFileDownloadClient();
  const fixture = prepareHostFileRead({ permissionMode: "read-only" });
  const outsidePath = outsideFile("private");
  fs.symlinkSync(outsidePath, path.join(workspaceRoot, "link"));
  for (const filePath of [outsidePath, "../outside", "link"]) {
    await fixture.files.error("download", filePath, undefined, connection);
  }
});

it("downloads Full Access host bytes without assistant-media policy", async () => {
  using connection = createSessionFileDownloadClient();
  const filename = "original.zip";
  const outsidePath = path.join(outsideDirs.make("session-download-host-"), filename);
  const bytes = Buffer.alloc(600_003, 0xff);
  bytes.write("PK\x03\x04", "binary");
  fs.writeFileSync(outsidePath, bytes);
  const fixture = prepareHostFileRead({ permissionMode: "full" });
  const download = await fixture.files.ok("download", outsidePath, undefined, {
    ...fixture.options,
    ...connection,
  });
  expect(download.filename).toBe(filename);
  const result = await connection.fetch(download.url);
  expect(result.response.statusCode).toBe(200);
  expect(Buffer.from(result.body as Uint8Array).equals(bytes)).toBe(true);
  fixture.entry.permissionMode = "read-only";
  expect((await connection.fetch(download.url)).response.statusCode).toBe(404);
  await fixture.files.error("download", outsidePath, undefined, {
    ...fixture.options,
    ...connection,
  });
});

it.each<[string, Partial<InternalSessionEntry>?, OpenClawConfig?]>([
  ["read-only mode", { permissionMode: "read-only" }],
  ["global filesystem policy", undefined, { tools: { fs: { workspaceOnly: true } } }],
  ["required sandbox in full mode", { permissionMode: "full", sandbox: "required" }],
  [
    "configured sandbox in full mode",
    { permissionMode: "full" },
    { agents: { defaults: { sandbox: { mode: "all" } } } },
  ],
  ["exec-node placement", { execNode: "build-mac" }],
])(
  "contains previews under %s without disclosing outside file existence",
  async (_label, entry, cfg) => {
    const outsidePath = outsideFile("outside\n");
    const fixture = prepareHostFileRead(entry, cfg);
    mockVisibleMessages([assistantToolCall("read", { path: outsidePath })]);

    for (const requestedPath of [
      outsidePath,
      path.relative(workspaceRoot, outsidePath),
      "~/.openclaw-outside-preview.txt",
      `${outsidePath}.missing`,
    ]) {
      expect((await fixture.files.error("get", requestedPath)).details).toMatchObject({
        path: requestedPath,
        ...outsideBoundary,
      });
    }
    const inRoot = await fixture.files.ok("get", "src/readme.md");
    expect(inRoot.file.content).toBe("# Read me\n");
  },
);

it("canonicalizes host previews and lists outside touched-file metadata without edit tokens", async () => {
  const outsidePath = outsideFile("outside\n");
  const aliasPath = path.join(path.dirname(outsidePath), "alias.txt");
  fs.symlinkSync(outsidePath, aliasPath);
  const fixture = prepareHostFileRead(
    { permissionMode: "full" },
    { tools: { fs: { workspaceOnly: true } } },
  );
  mockVisibleMessages([assistantToolCall("read", { path: aliasPath })]);

  for (const requestedPath of [aliasPath, path.relative(workspaceRoot, aliasPath)]) {
    const payload = await fixture.files.ok("get", requestedPath);
    expect(payload.file).toMatchObject({
      content: "outside\n",
      contentEncoding: "utf8",
      path: fs.realpathSync(outsidePath),
      workspacePath: fs.realpathSync(outsidePath),
      missing: false,
      previewKind: "text",
    });
    expect(payload.file).not.toHaveProperty("hash");
  }
  const list = await fixture.files.ok("list");
  expect(list.files).toEqual([
    expect.objectContaining({
      path: fs.realpathSync(outsidePath),
      workspacePath: fs.realpathSync(outsidePath),
      size: 8,
      missing: false,
    }),
  ]);
  expect(list.files[0]).not.toHaveProperty("content");
  expect(list.files[0]).not.toHaveProperty("hash");
  const hidden = expectOkPayload(
    await invoke("sessions.files.list", { sessionKey }, fixture.context),
  );
  expect(hidden.files).toEqual([]);
  const hardlinkedPath = path.join(path.dirname(outsidePath), "hardlinked.txt");
  fs.linkSync(outsidePath, hardlinkedPath);
  const hardlinked = await fixture.files.ok("get", hardlinkedPath);
  expect(hardlinked.file).toMatchObject({ content: "outside\n", missing: false });
});

it.each(["missing placement", "revoked policy"])("rejects host content after %s", async (mode) => {
  const outsidePath = outsideFile("outside\n");
  const fixture = prepareHostFileRead({ permissionMode: "full" });
  if (mode === "revoked policy") {
    const readWorkspaceFile = workspaceFs.readWorkspaceFile;
    vi.spyOn(workspaceFs, "readWorkspaceFile").mockImplementation(async (...args) => {
      const result = await readWorkspaceFile(...args);
      fixture.entry.permissionMode = "workspace";
      return result;
    });
  }
  const context =
    mode === "missing placement"
      ? { getRuntimeConfig: fixture.context.getRuntimeConfig }
      : fixture.context;
  expect((await fixture.files.error("get", outsidePath, context)).details).toMatchObject(
    outsideBoundary,
  );
});

it("keeps host previews bounded and classifies image and unsupported bytes", async () => {
  const fixture = prepareHostFileRead();
  const outsidePath = outsideFile();
  const cases = [
    { bytes: Buffer.from("GIF89a", "ascii"), previewKind: "image" },
    { bytes: Buffer.from("SQLite format 3\0"), previewKind: "unsupported" },
    { bytes: Buffer.alloc(256 * 1024 + 1, "x"), previewKind: "too_large" },
  ];
  for (const { bytes, previewKind } of cases) {
    fs.writeFileSync(outsidePath, bytes);
    const result = await fixture.files.request("get", outsidePath);
    if (previewKind === "too_large") {
      expect(expectError(result).details).toMatchObject({
        type: "session_file_too_large",
        maxPreviewBytes: 256 * 1024,
        size: bytes.length,
        root: workspaceRoot,
      });
    } else {
      const { file } = expectOkPayload(result);
      expect(file.previewKind).toBe(previewKind);
      expect(file).not.toHaveProperty("hash");
      if (previewKind === "image") {
        expect(file).toMatchObject({
          content: bytes.toString("base64"),
          contentEncoding: "base64",
        });
      } else {
        expect(file).not.toHaveProperty("content");
      }
    }
  }
});

it.runIf(process.platform !== "win32")(
  "rejects host directories and symlinks to special files",
  async () => {
    const fixture = prepareHostFileRead();
    const link = outsideFile();
    fs.symlinkSync("/dev/null", link);
    for (const requestedPath of [path.dirname(link), link]) {
      expect((await fixture.files.error("get", requestedPath)).details.type).toBe(
        "session_file_not_found",
      );
    }
  },
);

it("rejects escaped and symlinked write targets without touching outside files", async () => {
  const outsidePath = outsideFile();
  const escapedPath = path.join(path.dirname(outsidePath), "missing.txt");
  const escapedName = path.relative(path.dirname(workspaceRoot), escapedPath);
  const outsideContent = "outside\n";
  fs.writeFileSync(outsidePath, outsideContent, "utf8");
  fs.symlinkSync(outsidePath, path.join(workspaceRoot, "linked.txt"));
  const fixture = prepareHostFileRead({ permissionMode: "full" });

  for (const requestedPath of [outsidePath, `../${escapedName}`, "linked.txt"]) {
    const error = await fixture.files.error("set", {
      path: requestedPath,
      content: "replaced\n",
      expectedHash: hashContent(outsideContent),
    });
    expect(["session_file_not_found", "session_file_unsafe"]).toContain(error.details.type);
  }
  expect(fs.readFileSync(outsidePath, "utf8")).toBe(outsideContent);
  expect(fs.existsSync(escapedPath)).toBe(false);
});

const previewPolicy =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
function previewDocument(script: string) {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${previewPolicy}"><script defer src="${script}"></script></head><body><p>Ready</p></body></html>`;
}

it("serves only the preview's exact admitted bytes and retires them with their owner", async () => {
  using connection = createSessionFileDownloadClient();
  using other = createSessionFileDownloadClient();
  const fixture = prepareHostFileRead({ permissionMode: "read-only" });
  const html = previewDocument("app.js");
  const code = 'document.querySelector("p").textContent = "Loaded";';
  fs.writeFileSync(path.join(workspaceRoot, "index.html"), html);
  fs.writeFileSync(path.join(workspaceRoot, "app.js"), code);
  const options = { ...fixture.options, ...connection };
  const preview = await fixture.files.ok(
    "preview",
    { path: "index.html", html },
    undefined,
    options,
  );
  expect(preview.status).toBe("ready");
  expect(preview.html).toContain(`content="${previewPolicy}"`);
  const url = new URL("app.js", "http://preview.invalid" + preview.sandboxPath).pathname;
  const response = await connection.fetch(url);
  expect(response.response.statusCode).toBe(200);
  expect(Buffer.from(response.body as Uint8Array).toString()).toBe(code);
  expect(response.response.getHeader("content-type")).toBe("text/javascript; charset=utf-8");
  expect(response.response.getHeader("cache-control")).toBe("private, no-store");
  expect(response.response.getHeader("access-control-allow-origin")).toBeNull();
  expect((await connection.fetch(url + "?ungranted=1")).response.statusCode).toBe(404);
  expect((await connection.fetch(url.replace("app.js", "index.html"))).response.statusCode).toBe(
    404,
  );
  expect((await other.fetch(url)).response.statusCode).toBe(404);
  expect(
    (
      await fixture.files.ok(
        "preview.release",
        { path: "index.html", previewId: preview.previewId },
        undefined,
        { ...fixture.options, ...other },
      )
    ).released,
  ).toBe(false);
  fs.writeFileSync(path.join(workspaceRoot, "app.js"), "replacement");
  expect((await connection.fetch(url)).response.statusCode).toBe(404);
  fs.writeFileSync(path.join(workspaceRoot, "app.js"), code);
  expect(
    (
      await fixture.files.ok(
        "preview.release",
        { path: "index.html", previewId: preview.previewId },
        undefined,
        options,
      )
    ).released,
  ).toBe(true);
  expect((await connection.fetch(url)).response.statusCode).toBe(404);
  expect(fs.readFileSync(path.join(workspaceRoot, "index.html"), "utf8")).toBe(html);
});

it("rechecks preview host-read authority after the asset read before HTTP delivery", async () => {
  using connection = createSessionFileDownloadClient();
  const fixture = prepareHostFileRead({ permissionMode: "full" });
  const external = path.join(outsideDirs.make("preview-private-"), "asset.js");
  fs.writeFileSync(external, "window.privateValue = 1;");
  const html = previewDocument(path.relative(workspaceRoot, external));
  fs.writeFileSync(path.join(workspaceRoot, "index.html"), html);
  const preview = await fixture.files.ok("preview", { path: "index.html", html }, undefined, {
    ...fixture.options,
    ...connection,
  });
  expect(preview.status).toBe("ready");
  const url = new URL(
    path.relative(workspaceRoot, external),
    "http://preview.invalid" + preview.sandboxPath,
  ).pathname;
  const read = workspaceFs.readWorkspaceFile;
  vi.spyOn(workspaceFs, "readWorkspaceFile").mockImplementationOnce(async (...args) => {
    const result = await read(...args);
    fixture.entry.permissionMode = "read-only";
    return result;
  });
  expect((await connection.fetch(url)).response.statusCode).toBe(404);
});
