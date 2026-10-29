import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { withSessionTranscriptDeltaReader } from "../../config/sessions/session-transcript-delta-read.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  assistantToolCall,
  useSqliteSession,
  visibleMessageEvent,
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectOkPayload,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";

const hoisted = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readDelta: vi.fn(),
}));

vi.mock("./open-path.js", async () => {
  const actual = await vi.importActual<typeof import("./open-path.js")>("./open-path.js");
  return { ...actual, execOpenPath: hoisted.execOpenPath };
});

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: hoisted.resolveDefaultAgentId,
}));

vi.mock("../session-utils.js", async (original) => ({
  ...(await original<typeof import("../session-utils.js")>()),
  loadIncognitoGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
}));

vi.mock("../session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: async (params: { key: string; agentId?: string }) =>
    hoisted.loadSessionEntry(params.key, { agentId: params.agentId }),
}));

// mock-isolation: File-policy tests supply visible transcript pages without opening SQLite.
vi.mock("../../config/sessions/session-transcript-delta-read.js", () => ({
  withSessionTranscriptDeltaReader: ((scope, consume) =>
    consume({
      visible: async (limits) => hoisted.readDelta(scope, limits),
      raw: async () => {
        throw new Error("File browsing must consume visible transcript pages");
      },
    })) satisfies typeof withSessionTranscriptDeltaReader,
}));

const sessionKey = "agent:main:main";
const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
function listFiles(params: Record<string, unknown> = {}) {
  return invoke("sessions.files.list", { sessionKey, ...params });
}

const outsideDirs = useAutoCleanupTempDirTracker(afterEach);
const outsideFile = () => path.join(outsideDirs.make("session-files-outside-"), "outside.txt");

const mockVisibleMessages = createVisibleMessagesMock(hoisted.readDelta);

let workspaceRoot: string;
beforeEach(() => {
  workspaceRoot = prepareSessionFilesTest(hoisted, mockVisibleMessages);
});

afterEach(() => {
  removeWorkspaceFixture(workspaceRoot);
});

describe("sessions.files touched-file folds", () => {
  function page(
    cursor: string,
    events: ReturnType<typeof visibleMessageEvent>[] = [],
    hasMore = false,
  ) {
    return { kind: "page", cursor, events, hasMore, serializedBytes: 100 };
  }
  const listTouched = async () => expectOkPayload(await listFiles());
  const touchedKinds = (payload: Record<string, unknown>[]) =>
    payload.map((file) => [file.path, file.kind]);

  it("retains incremental cursors across more than 16 concurrently viewed sessions", async () => {
    hoisted.resolveAgentWorkspaceDir.mockReturnValue(undefined);
    const storePath = path.join(workspaceRoot, "visible-sessions.sqlite");
    hoisted.loadSessionEntry.mockImplementation((key: string) => {
      const sessionId = key.split(":").at(-1)!;
      return {
        agentId: "main",
        canonicalKey: key,
        cfg: {},
        storePath,
        entry: { sessionId, sessionFile: `sqlite:main:${sessionId}:${storePath}` },
      };
    });
    hoisted.readDelta.mockImplementation((scope) => page(`${scope.sessionId}-cursor`, [], false));

    const sessionKeys = Array.from({ length: 24 }, (_, index) => `agent:main:visible-${index}`);
    for (const key of sessionKeys) {
      expectOkPayload(await invoke("sessions.files.list", { sessionKey: key }));
    }
    expectOkPayload(await invoke("sessions.files.list", { sessionKey: sessionKeys[0] }));

    expect(hoisted.readDelta.mock.lastCall?.[1]).toMatchObject({
      cursor: "visible-0-cursor",
    });
  });

  it("yields between SQLite pages and shares one concurrent fold per session", async () => {
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, "sess-touched-singleflight");
    const firstPageRead = createDeferred();
    let otherWorkRan = false;
    setImmediate(() => {
      otherWorkRan = true;
    });
    hoisted.readDelta.mockImplementation((_scope, limits) => {
      if (limits.cursor !== undefined) {
        expect(limits.cursor).toBe("singleflight-page-1");
        expect(otherWorkRan).toBe(true);
      } else {
        firstPageRead.resolve();
      }
      return page(
        limits.cursor === undefined ? "singleflight-page-1" : "singleflight-final",
        [],
        limits.cursor === undefined,
      );
    });

    const params = { sessionKey };
    const first = invoke("sessions.files.list", params);
    const second = invoke("sessions.files.list", params);

    await firstPageRead.promise;
    expect(hoisted.readDelta).toHaveBeenCalledTimes(1);
    for (const result of await Promise.all([first, second])) {
      expectOkPayload(result);
    }
    expect(hoisted.readDelta).toHaveBeenCalledTimes(2);
  });

  it("isolates touched-file folds for the same session across stores", async () => {
    const sessionId = "sess-touched-multi-store";
    const firstStorePath = path.join(workspaceRoot, "store-a.sqlite");
    const secondStorePath = path.join(workspaceRoot, "store-b.sqlite");
    hoisted.readDelta.mockImplementation((scope, limits) => {
      expect(limits.cursor).toBeUndefined();
      const message =
        scope.storePath === firstStorePath
          ? assistantToolCall("read", { path: "src/readme.md" })
          : assistantToolCall("edit", { path: "ui/chat.ts" });
      return page(`${scope.storePath}-final`, [visibleMessageEvent(message, 1)], false);
    });

    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, sessionId, firstStorePath);
    const first = await listTouched();
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, sessionId, secondStorePath);
    const second = await listTouched();

    expect(first.files).toEqual([expect.objectContaining({ path: "src/readme.md", kind: "read" })]);
    expect(second.files).toEqual([
      expect.objectContaining({ path: "ui/chat.ts", kind: "modified" }),
    ]);
  });

  it("rebuilds the SQLite fold from the bootstrap cursor after a reset", async () => {
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, "sess-touched-reset");
    hoisted.readDelta.mockImplementation((_scope, limits) => {
      if (limits.cursor === undefined) {
        return page(
          "generation-1",
          [visibleMessageEvent(assistantToolCall("read", { path: "src/readme.md" }), 1)],
          false,
        );
      }
      if (limits.cursor === "generation-1") {
        return {
          kind: "reset",
          cursor: "generation-2-bootstrap",
          reason: "generation_mismatch",
        };
      }
      if (limits.cursor === "generation-2-bootstrap") {
        return page(
          "generation-2-final",
          [visibleMessageEvent(assistantToolCall("edit", { path: "ui/chat.ts" }), 1)],
          false,
        );
      }
      throw new Error(`unexpected cursor: ${String(limits.cursor)}`);
    });

    const beforeReset = await listTouched();
    const afterReset = await listTouched();

    expect(beforeReset.files).toEqual([
      expect.objectContaining({ path: "src/readme.md", kind: "read" }),
    ]);
    expect(afterReset.files).toEqual([
      expect.objectContaining({ path: "ui/chat.ts", kind: "modified" }),
    ]);
    expect(hoisted.readDelta).toHaveBeenCalledTimes(3);
  });

  it("collects touched files from existing transcript tool-call spellings", async () => {
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, "sess-touched-spellings");
    mockVisibleMessages([
      {
        role: "assistant",
        content: [
          { type: "tool_use", name: "read", input: { path: "src/readme.md" } },
          { type: "toolcall", name: "edit", arguments: { path: "ui/vite.config.ts" } },
          { type: "tool_use", name: "read", args: { path: "ui/chat.ts" } },
          {
            type: "tool_call",
            name: "apply_patch",
            input: {
              input: "*** Begin Patch\n*** Update File: package.json\n*** End Patch\n",
            },
          },
        ],
      },
    ]);

    const payload = await listTouched();

    expect(touchedKinds(payload.files)).toEqual([
      ["package.json", "modified"],
      ["ui/vite.config.ts", "modified"],
      ["src/readme.md", "read"],
      ["ui/chat.ts", "read"],
    ]);
  });

  it("collects changed files from structured apply_patch changes", async () => {
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, "sess-touched-structured-patch");
    mockVisibleMessages([
      assistantToolCall("apply_patch", {
        changes: [
          { path: "ui/chat.ts", kind: "update" },
          { path: "src/readme.md", kind: "delete" },
          { path: "old-name.md", kind: { type: "update", move_path: "package.json" } },
        ],
      }),
    ]);

    const payload = await listTouched();

    expect(touchedKinds(payload.files)).toEqual([
      ["old-name.md", "modified"],
      ["package.json", "modified"],
      ["src/readme.md", "modified"],
      ["ui/chat.ts", "modified"],
    ]);
  });

  it("omits transcript paths outside the workspace without hiding missing workspace files", async () => {
    useSqliteSession(hoisted.loadSessionEntry, workspaceRoot, "sess-touched-outside-paths");
    const outsidePath = outsideFile();
    fs.writeFileSync(outsidePath, "outside\n", "utf8");
    mockVisibleMessages(
      [
        outsidePath,
        "../outside.txt",
        "~/.openclaw-external.txt",
        pathToFileURL(outsidePath).href,
        `@${outsidePath}`,
        "..cache/missing.txt",
        "missing.txt",
        "src/readme.md",
      ].map((filePath) => assistantToolCall("read", { path: filePath })),
    );

    const payload = await listTouched();

    expect(payload.files).toHaveLength(3);
    expect(payload.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "..cache/missing.txt", missing: true }),
        expect.objectContaining({ path: "missing.txt", missing: true }),
        expect.objectContaining({
          path: "src/readme.md",
          missing: false,
          workspacePath: "src/readme.md",
        }),
      ]),
    );
  });
});
