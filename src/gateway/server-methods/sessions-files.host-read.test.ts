import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  assistantToolCall,
  IMAGE_PREVIEW_FIXTURES,
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectError,
  expectOkPayload,
  hashContent,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";
import * as workspaceFs from "./workspace-fs.js";

const hoisted = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readDelta: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../session-utils.js", async (original) => ({
  ...(await original<typeof import("../session-utils.js")>()),
  loadSessionEntry: hoisted.loadSessionEntry,
  loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
}));

vi.mock("../session-transcript-readers.js", async (original) => ({
  ...(await original<typeof import("../session-transcript-readers.js")>()),
  readSessionTranscriptVisibleMessageDeltaCore: hoisted.readDelta,
}));

const sessionKey = "agent:main:main";
const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const listFiles = () => invoke("sessions.files.list", { sessionKey });
const outsideDirs = useAutoCleanupTempDirTracker(afterEach);
const outsideFile = () => path.join(outsideDirs.make("session-files-outside-"), "outside.txt");
const mockVisibleMessages = createVisibleMessagesMock(hoisted.readDelta);

let workspaceRoot: string;
beforeEach(() => {
  workspaceRoot = prepareSessionFilesTest(
    { ...hoisted, readSessionTranscriptVisibleMessageDeltaCore: hoisted.readDelta },
    mockVisibleMessages,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  removeWorkspaceFixture(workspaceRoot);
});

function prepareHostFileRead(
  overrides: Partial<InternalSessionEntry> = {},
  cfg: OpenClawConfig = {},
) {
  const entry: InternalSessionEntry = {
    sessionId: "sess-main",
    updatedAt: 1,
    sessionFile: "sess-main.jsonl",
    spawnedCwd: workspaceRoot,
    ...overrides,
  };
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
  return { context, options, entry };
}

describe("sessions.files host read boundary", () => {
  it.each<{
    label: string;
    entry?: Partial<InternalSessionEntry>;
    cfg?: OpenClawConfig;
  }>([
    { label: "read-only mode", entry: { permissionMode: "read-only" } },
    { label: "guarded mode", entry: { permissionMode: "guarded" } },
    { label: "workspace mode", entry: { permissionMode: "workspace" } },
    { label: "global filesystem policy", cfg: { tools: { fs: { workspaceOnly: true } } } },
    {
      label: "agent filesystem policy",
      cfg: { agents: { list: [{ id: "main", tools: { fs: { workspaceOnly: true } } }] } },
    },
    {
      label: "required sandbox in full mode",
      entry: { permissionMode: "full", sandbox: "required" },
    },
    {
      label: "configured sandbox in full mode",
      entry: { permissionMode: "full" },
      cfg: { agents: { defaults: { sandbox: { mode: "all" } } } },
    },
    { label: "exec-node placement", entry: { execNode: "build-mac" } },
  ])(
    "contains previews under $label without disclosing outside file existence",
    async ({ entry, cfg }) => {
      const outsidePath = outsideFile();
      fs.writeFileSync(outsidePath, "outside\n", "utf8");
      const fixture = prepareHostFileRead(entry, cfg);
      mockVisibleMessages([assistantToolCall("read", { path: outsidePath })]);

      for (const requestedPath of [
        outsidePath,
        path.relative(workspaceRoot, outsidePath),
        "~/.openclaw-outside-preview.txt",
        `${outsidePath}.missing`,
      ]) {
        const error = expectError(
          await invoke(
            "sessions.files.get",
            {
              sessionKey,
              path: requestedPath,
            },
            fixture.context,
            fixture.options,
          ),
        );

        expect(error.details).toMatchObject({
          path: requestedPath,
          type: "session_file_not_found",
          reason: "outside_session_boundary",
        });
      }
      const inRoot = expectOkPayload(
        await invoke(
          "sessions.files.get",
          {
            sessionKey,
            path: "src/readme.md",
          },
          fixture.context,
          fixture.options,
        ),
      );
      expect(inRoot.file.content).toBe("# Read me\n");
    },
  );

  it("requires a current local placement observation before using host file scope", async () => {
    const outsidePath = outsideFile();
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    const fixture = prepareHostFileRead({ permissionMode: "full" });
    const error = expectError(
      await invoke(
        "sessions.files.get",
        {
          sessionKey,
          path: outsidePath,
        },
        { getRuntimeConfig: fixture.context.getRuntimeConfig },
        fixture.options,
      ),
    );
    expect(error.details).toMatchObject({
      type: "session_file_not_found",
      reason: "outside_session_boundary",
    });
  });

  it("canonicalizes host previews and lists outside touched-file metadata without edit tokens", async () => {
    const outsidePath = outsideFile();
    const aliasPath = path.join(path.dirname(outsidePath), "alias.txt");
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    fs.symlinkSync(outsidePath, aliasPath);
    const fixture = prepareHostFileRead(
      { permissionMode: "full" },
      { tools: { fs: { workspaceOnly: true } } },
    );
    mockVisibleMessages([assistantToolCall("read", { path: aliasPath })]);

    for (const requestedPath of [aliasPath, path.relative(workspaceRoot, aliasPath)]) {
      const payload = expectOkPayload(
        await invoke(
          "sessions.files.get",
          {
            sessionKey,
            path: requestedPath,
          },
          fixture.context,
          fixture.options,
        ),
      );
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
    const list = expectOkPayload(
      await invoke("sessions.files.list", { sessionKey }, fixture.context, fixture.options),
    );
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
    const hidden = expectOkPayload(await listFiles());
    expect(hidden.files).toEqual([]);
    const hardlinkedPath = path.join(path.dirname(outsidePath), "hardlinked.txt");
    fs.linkSync(outsidePath, hardlinkedPath);
    const hardlinked = expectOkPayload(
      await invoke(
        "sessions.files.get",
        { sessionKey, path: hardlinkedPath },
        fixture.context,
        fixture.options,
      ),
    );
    expect(hardlinked.file).toMatchObject({ content: "outside\n", missing: false });
  });

  it("rechecks the file policy after reading before publishing host content", async () => {
    const outsidePath = outsideFile();
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    const fixture = prepareHostFileRead({ permissionMode: "full" });
    const readWorkspaceFile = workspaceFs.readWorkspaceFile;
    vi.spyOn(workspaceFs, "readWorkspaceFile").mockImplementation(async (...args) => {
      const result = await readWorkspaceFile(...args);
      fixture.entry.permissionMode = "workspace";
      return result;
    });
    const error = expectError(
      await invoke(
        "sessions.files.get",
        {
          sessionKey,
          path: outsidePath,
        },
        fixture.context,
        fixture.options,
      ),
    );
    expect(error.details).toMatchObject({
      type: "session_file_not_found",
      reason: "outside_session_boundary",
    });
  });

  it("keeps host previews bounded and classifies image and unsupported bytes", async () => {
    const fixture = prepareHostFileRead();
    const outsidePath = outsideFile();
    const cases = [
      { bytes: IMAGE_PREVIEW_FIXTURES[0].bytes, previewKind: "image" },
      {
        bytes: Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(64, 7)]),
        previewKind: "unsupported",
      },
      { bytes: Buffer.alloc(256 * 1024 + 1, "x"), previewKind: "too_large" },
    ];
    for (const { bytes, previewKind } of cases) {
      fs.writeFileSync(outsidePath, bytes);
      const result = await invoke(
        "sessions.files.get",
        { sessionKey, path: outsidePath },
        fixture.context,
        fixture.options,
      );
      if (previewKind === "too_large") {
        expect(expectError(result).details).toMatchObject({
          type: "session_file_too_large",
          maxPreviewBytes: 256 * 1024,
          size: bytes.length,
        });
      } else {
        const { file } = expectOkPayload(result);
        expect(file.previewKind).toBe(previewKind);
        expect(file).not.toHaveProperty("hash");
        if (previewKind === "image") {
          expect(file.content).toBe(bytes.toString("base64"));
          expect(file.contentEncoding).toBe("base64");
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
        const error = expectError(
          await invoke(
            "sessions.files.get",
            {
              sessionKey,
              path: requestedPath,
            },
            fixture.context,
            fixture.options,
          ),
        );
        expect(error.details.type).toBe("session_file_not_found");
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
      const error = expectError(
        await invoke(
          "sessions.files.set",
          {
            sessionKey,
            path: requestedPath,
            content: "replaced\n",
            expectedHash: hashContent(outsideContent),
          },
          fixture.context,
          fixture.options,
        ),
      );
      expect(["session_file_not_found", "session_file_unsafe"]).toContain(error.details.type);
    }
    expect(fs.readFileSync(outsidePath, "utf8")).toBe(outsideContent);
    expect(fs.existsSync(escapedPath)).toBe(false);
  });
});
