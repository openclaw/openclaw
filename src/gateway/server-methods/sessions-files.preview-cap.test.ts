// Workspace preview cap tests: the configurable gateway.workspacePreviewMaxBytes
// limit on top of the 256 KiB default.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  assistantToolCall,
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectError,
  expectOkPayload,
  hashContent,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
  writeWorkspaceFile,
} from "./sessions-files.test-support.js";

const hoisted = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readSessionTranscriptVisibleMessageDeltaCore: vi.fn(),
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

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: hoisted.loadSessionEntry,
    loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    readSessionTranscriptVisibleMessageDeltaCore:
      hoisted.readSessionTranscriptVisibleMessageDeltaCore,
  };
});

const invokeSessionFilesHandler = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const mockVisibleMessages = createVisibleMessagesMock(
  hoisted.readSessionTranscriptVisibleMessageDeltaCore,
);

const raisedCapContext = {
  getRuntimeConfig: () => ({
    agents: { list: [{ id: "main", default: true }] },
    gateway: { workspacePreviewMaxBytes: 1024 * 1024 },
  }),
};

describe("sessions.files workspacePreviewMaxBytes", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = prepareSessionFilesTest(hoisted, mockVisibleMessages);
  });

  afterEach(() => {
    removeWorkspaceFixture(workspaceRoot);
  });

  it("previews files above the default cap when workspacePreviewMaxBytes is raised", async () => {
    writeWorkspaceFile(workspaceRoot, "raised.log", "x".repeat(260 * 1024));
    mockVisibleMessages([assistantToolCall("read", { path: "raised.log" })]);

    const payload = expectOkPayload(
      await invokeSessionFilesHandler(
        "sessions.files.get",
        { sessionKey: "agent:main:main", path: "raised.log" },
        raisedCapContext,
      ),
    );

    expect(payload.file).toMatchObject({
      content: "x".repeat(260 * 1024),
      path: "raised.log",
      previewKind: "text",
    });
  });

  it("reports the configured cap when a file exceeds workspacePreviewMaxBytes", async () => {
    writeWorkspaceFile(workspaceRoot, "huge.log", "x".repeat(2 * 1024 * 1024));
    mockVisibleMessages([assistantToolCall("read", { path: "huge.log" })]);

    const error = expectError(
      await invokeSessionFilesHandler(
        "sessions.files.get",
        { sessionKey: "agent:main:main", path: "huge.log" },
        raisedCapContext,
      ),
    );

    expect(error.details).toMatchObject({
      maxPreviewBytes: 1024 * 1024,
      path: "huge.log",
      type: "session_file_too_large",
    });
  });

  it("round-trips files above the default cap through get, set, and reopen when workspacePreviewMaxBytes is raised", async () => {
    const original = `${"x".repeat(260 * 1024 - 1)}\n`;
    const replacement = `${"y".repeat(260 * 1024 - 1)}\n`;
    writeWorkspaceFile(workspaceRoot, "raised-save.log", original);
    mockVisibleMessages([assistantToolCall("read", { path: "raised-save.log" })]);

    const preview = expectOkPayload(
      await invokeSessionFilesHandler(
        "sessions.files.get",
        { sessionKey: "agent:main:main", path: "raised-save.log" },
        raisedCapContext,
      ),
    );
    expect(preview.file.content).toBe(original);
    expect(preview.file.hash).toBe(hashContent(original));

    const saved = expectOkPayload(
      await invokeSessionFilesHandler(
        "sessions.files.set",
        {
          sessionKey: "agent:main:main",
          path: "raised-save.log",
          content: replacement,
          expectedHash: hashContent(original),
        },
        raisedCapContext,
      ),
    );
    expect(saved.file.hash).toBe(hashContent(replacement));

    const reopened = expectOkPayload(
      await invokeSessionFilesHandler(
        "sessions.files.get",
        { sessionKey: "agent:main:main", path: "raised-save.log" },
        raisedCapContext,
      ),
    );
    expect(reopened.file.content).toBe(replacement);
  });
});
