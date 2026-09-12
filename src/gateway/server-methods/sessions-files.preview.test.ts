import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectError,
  expectOkPayload,
  hashContent,
  IMAGE_PREVIEW_FIXTURES,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
  TEXT_PREVIEW_FIXTURES,
} from "./sessions-files.test-support.js";

const mocks = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readSessionTranscriptVisibleMessageDeltaCore: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));
vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: mocks.loadSessionEntry,
    loadGatewaySessionEntryReadOnly: mocks.loadSessionEntry,
  };
});
vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    readSessionTranscriptVisibleMessageDeltaCore:
      mocks.readSessionTranscriptVisibleMessageDeltaCore,
  };
});

const invokeSessionFilesHandler = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const mockVisibleMessages = createVisibleMessagesMock(
  mocks.readSessionTranscriptVisibleMessageDeltaCore,
);

describe("sessions.files preview formats", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = prepareSessionFilesTest(mocks, mockVisibleMessages);
  });
  afterEach(() => {
    removeWorkspaceFixture(workspaceRoot);
  });

  it.each(IMAGE_PREVIEW_FIXTURES)(
    "previews sniffed $format bytes as a base64 image without a CAS hash",
    async (fixture) => {
      const fileName = `preview-${fixture.format.toLowerCase()}.bin`;
      fs.writeFileSync(path.join(workspaceRoot, fileName), fixture.bytes);
      const payload = expectOkPayload(
        await invokeSessionFilesHandler("sessions.files.get", {
          sessionKey: "agent:main:main",
          path: fileName,
        }),
      );
      expect(payload.file).toMatchObject({
        content: fixture.bytes.toString("base64"),
        contentEncoding: "base64",
        mimeType: fixture.mimeType,
        path: fileName,
        previewKind: "image",
      });
      expect(payload.file.hash).toBeUndefined();
    },
  );

  it.each(TEXT_PREVIEW_FIXTURES)("keeps detected $format text editable", async (fixture) => {
    const fileName = `detected-${fixture.format.toLowerCase().replaceAll(" ", "-")}.bin`;
    fs.writeFileSync(path.join(workspaceRoot, fileName), fixture.content, "utf8");
    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: fileName,
      }),
    );
    expect(payload.file).toMatchObject({
      content: fixture.content,
      contentEncoding: "utf8",
      hash: hashContent(fixture.content),
      mimeType: fixture.mimeType,
      path: fileName,
      previewKind: "text",
    });
  });

  it("returns unsupported binary metadata without lossy inline content", async () => {
    const binary = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(64, 7)]);
    fs.writeFileSync(path.join(workspaceRoot, "cache.db"), binary);
    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "cache.db",
      }),
    );
    expect(payload.file).toMatchObject({
      mimeType: "application/x-sqlite3",
      missing: false,
      path: "cache.db",
      previewKind: "unsupported",
      size: binary.length,
    });
    expect(payload.file.content).toBeUndefined();
    expect(payload.file.contentEncoding).toBeUndefined();
    expect(payload.file.hash).toBeUndefined();
  });

  const raisedCapContext = {
    getRuntimeConfig: () => ({
      agents: { list: [{ id: "main", default: true }] },
      gateway: { workspacePreviewMaxBytes: 1024 * 1024 },
    }),
  };

  it("previews in-root files above the default cap when workspacePreviewMaxBytes is raised", async () => {
    fs.writeFileSync(path.join(workspaceRoot, "raised.log"), "x".repeat(260 * 1024));

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
    fs.writeFileSync(path.join(workspaceRoot, "huge.log"), "x".repeat(2 * 1024 * 1024));

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
    fs.writeFileSync(path.join(workspaceRoot, "raised-save.log"), original);

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
