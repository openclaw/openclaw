import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withNodeWorkerUploadSnapshot } from "./node-worker-upload-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const content = Buffer.from("captured workspace bytes");
const source = {
  path: "source.bin",
  size: content.byteLength,
  sha256: createHash("sha256").update(content).digest("hex"),
};

describe("node worker upload snapshot scope", () => {
  it.each([false, true])(
    "scopes frozen literal paths and hardlinks through an alias (upload fails: %s)",
    async (fails) => {
      const root = tempDirs.make("worker-upload-snapshot-");
      const workspaceDir = path.join(root, "workspace");
      const alias = path.join(root, "workspace-alias");
      const sharedFile = path.join(root, "shared.bin");
      const sourcePath = "~/source.bin";
      await fs.mkdir(path.join(workspaceDir, "~"), { recursive: true });
      await fs.writeFile(sharedFile, content);
      await fs.link(sharedFile, path.join(workspaceDir, sourcePath));
      await fs.symlink(workspaceDir, alias, "junction");
      let readAfterScope: (() => Promise<void>) | undefined;
      const failure = new Error("upload failed");

      const uploading = withNodeWorkerUploadSnapshot(
        { workspaceDir: alias, sources: [{ ...source, path: sourcePath }] },
        async (snapshot) => {
          const file = snapshot.files[0]!;
          readAfterScope = () => snapshot.stream(file, async () => {});
          expect(file.size).toBe(content.byteLength);
          if (!fails) {
            await fs.writeFile(sharedFile, "later workspace edit");
          }
          const chunks: Buffer[] = [];
          await snapshot.stream(file, async (chunk) => {
            chunks.push(Buffer.from(chunk));
          });
          expect(Buffer.concat(chunks)).toEqual(content);
          if (fails) {
            throw failure;
          }
          return "uploaded";
        },
      );

      if (fails) {
        await expect(uploading).rejects.toBe(failure);
      } else {
        await expect(uploading).resolves.toBe("uploaded");
      }
      await expect(readAfterScope!()).rejects.toThrow();
      await expect(fs.readFile(sharedFile)).resolves.toEqual(
        fails ? content : Buffer.from("later workspace edit"),
      );
    },
  );

  it("accepts an empty source list while still requiring the workspace to exist", async () => {
    const workspaceDir = tempDirs.make("worker-upload-empty-");
    const upload = vi.fn(async (snapshot: { files: unknown[] }) => snapshot.files);

    await expect(
      withNodeWorkerUploadSnapshot({ workspaceDir, sources: [] }, upload),
    ).resolves.toEqual([]);
    expect(upload).toHaveBeenCalledOnce();
    upload.mockClear();
    await expect(
      withNodeWorkerUploadSnapshot(
        { workspaceDir: path.join(workspaceDir, "missing"), sources: [] },
        upload,
      ),
    ).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
  });

  it("does not begin uploading a cancelled snapshot", async () => {
    const workspaceDir = tempDirs.make("worker-upload-cancelled-");
    await fs.writeFile(path.join(workspaceDir, source.path), content);
    const controller = new AbortController();
    const cancelled = new Error("upload cancelled");
    controller.abort(cancelled);
    const upload = vi.fn(async () => undefined);

    await expect(
      withNodeWorkerUploadSnapshot(
        { workspaceDir, sources: [source], signal: controller.signal },
        upload,
      ),
    ).rejects.toBe(cancelled);
    expect(upload).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(workspaceDir, source.path))).resolves.toEqual(content);
  });

  it("cancels a staged upload when opening its file outlives its caller", async ({ signal }) => {
    const workspaceDir = tempDirs.make("worker-upload-open-cancelled-");
    await fs.writeFile(path.join(workspaceDir, source.path), content);
    const controller = new AbortController();
    const cancelled = new Error("upload cancelled while opening its staged file");
    const readOpened = createDeferred();
    const releaseOpen = createDeferred();
    const write = vi.fn(async (_chunk: Buffer) => {});
    let readClosed = false;
    const open = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const [filePath, flags] = args;
      if (
        typeof filePath === "string" &&
        path.basename(path.dirname(filePath)).startsWith("worker-workspace-upload-") &&
        path.basename(filePath) === "0" &&
        typeof flags === "number" &&
        (flags & (constants.O_WRONLY | constants.O_RDWR)) === 0
      ) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          await close();
          readClosed = true;
        });
        readOpened.resolve();
        await releaseOpen.promise;
      }
      return handle;
    });
    const operation = withNodeWorkerUploadSnapshot(
      { workspaceDir, sources: [source] },
      (snapshot) => snapshot.stream(snapshot.files[0]!, write, controller.signal),
    );
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          readOpened.promise,
          operation,
          "Upload settled before opening its staged file",
        ),
        signal,
      );
      controller.abort(cancelled);
      releaseOpen.resolve();
      await expect(withinTest(operation, signal)).rejects.toBe(cancelled);
      expect(write).not.toHaveBeenCalled();
      expect(readClosed).toBe(true);
    } finally {
      releaseOpen.resolve();
      await operation.catch(() => undefined);
      openSpy.mockRestore();
    }
  });
});
