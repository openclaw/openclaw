import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { root as openSafeRoot } from "../../infra/fs-safe.js";
import { resolveLocalSessionWorkspaceRoot, sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectOkPayload,
  expectError,
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
  const remoteDirs = useAutoCleanupTempDirTracker(afterEach);
  let releaseRemote: (() => void) | undefined;

  beforeEach(() => {
    workspaceRoot = prepareSessionFilesTest(mocks, mockVisibleMessages);
  });
  afterEach(() => {
    releaseRemote?.();
    releaseRemote = undefined;
    removeWorkspaceFixture(workspaceRoot);
  });

  it("browses and previews the workspace owner's files without exposing a local copy or unsafe edits", async () => {
    const remote = remoteDirs.make("session-remote-preview-");
    fs.writeFileSync(path.join(workspaceRoot, "result.json"), "Gateway decoy");
    fs.symlinkSync("result.json", path.join(remote, "result-link.json"));
    fs.writeFileSync(path.join(remote, "result.json"), '{"total":46}');
    fs.writeFileSync(path.join(remote, "large.txt"), "x".repeat(256 * 1024 + 1));
    const owner = await openSafeRoot(remote, { symlinks: "reject" });
    let includeFileTypes = true;
    let denyLegacyChild = false;
    const ownerPath = (filePath: string) => path.relative(workspaceRoot, filePath);
    const readFile = vi.fn(
      async ({ filePath, maxBytes }: { filePath: string; maxBytes?: number }) =>
        (await owner.read(ownerPath(filePath), { maxBytes })).buffer,
    );
    releaseRemote = registerAgentWorkspaceAccess(workspaceRoot, {
      bridge: {
        readFile,
        writeFile: async () => {
          throw new Error("Unexpected non-CAS write");
        },
        stat: async ({ filePath }) => {
          if (denyLegacyChild && ownerPath(filePath) === "result.json") {
            throw Object.assign(new Error("node denied file stat"), { code: "PERMISSION_DENIED" });
          }
          const stat = fs.lstatSync(path.join(remote, ownerPath(filePath)), {
            throwIfNoEntry: false,
          });
          if (!stat) {
            return null;
          }
          if (stat.isSymbolicLink()) {
            throw Object.assign(new Error("node rejected symlink"), { code: "SYMLINK_REDIRECT" });
          }
          return {
            type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          };
        },
        readDirectory: async ({ filePath }) =>
          (await owner.list(ownerPath(filePath), { withFileTypes: true })).map((entry) => ({
            name: entry.name,
            isDirectory: entry.isDirectory,
            isFile: includeFileTypes ? entry.isFile : undefined,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
          })),
      },
    });
    const get = (filePath: string) =>
      invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: filePath,
      });
    const payload = expectOkPayload(await get("result.json"));
    expect(payload.file).toMatchObject({
      content: '{"total":46}',
      previewKind: "text",
      missing: false,
    });
    expect(payload.file.hash).toBeUndefined();
    const listed = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );
    expect(listed.browser.entries.map((entry: { name: string }) => entry.name)).toEqual([
      "large.txt",
      "result.json",
    ]);
    expect(listed.gitCheckout).toBeUndefined();
    includeFileTypes = false;
    // Older nodes reject symlink stats instead of returning a file type.
    const legacyListing = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    );
    expect(legacyListing.browser.entries.map((entry: { name: string }) => entry.name)).toEqual([
      "large.txt",
      "result.json",
    ]);
    denyLegacyChild = true;
    await expect(
      invokeSessionFilesHandler("sessions.files.list", {
        sessionKey: "agent:main:main",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    denyLegacyChild = false;
    expect(resolveLocalSessionWorkspaceRoot({ sessionKey: "agent:main:main" })).toBeUndefined();
    const reveal = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.reveal", {
        key: "agent:main:main",
      }),
    );
    expect(reveal).toMatchObject({ ok: false, error: expect.stringContaining("remote host") });
    expect(expectError(await get("large.txt")).details.type).toBe("session_file_too_large");
    expect(readFile).toHaveBeenCalledTimes(1);
    await expect(
      invokeSessionFilesHandler("sessions.files.set", {
        sessionKey: "agent:main:main",
        path: "result.json",
        content: "changed",
        expectedHash: hashContent('{"total":46}'),
      }),
    ).rejects.toThrow("conflict-safe editing");
    expect(fs.readFileSync(path.join(workspaceRoot, "result.json"), "utf8")).toBe("Gateway decoy");
    releaseRemote();
    await expect(get("result.json")).rejects.toThrow("stopped or not ready");
  });

  it("reports the preview limit when a remote file grows between stat and fetch", async () => {
    releaseRemote = registerAgentWorkspaceAccess(workspaceRoot, {
      bridge: {
        stat: async () => ({ type: "file", size: 14, mtimeMs: 1 }),
        readFile: async () => {
          throw Object.assign(new Error("node refused oversized file"), { code: "FILE_TOO_LARGE" });
        },
        writeFile: async () => {
          throw new Error("unexpected write");
        },
      },
    });
    const result = await invokeSessionFilesHandler("sessions.files.get", {
      sessionKey: "agent:main:main",
      path: "growing.txt",
    });
    expect(expectError(result).details.type).toBe("session_file_too_large");
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
});
