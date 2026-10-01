import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("freezes literal manifest paths and hardlinks through a workspace alias", async () => {
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

    const result = await withNodeWorkerUploadSnapshot(
      { workspaceDir: alias, sources: [{ ...source, path: sourcePath }] },
      async (snapshot) => {
        const file = snapshot.files[0]!;
        readAfterScope = () => snapshot.stream(file, async () => {});
        expect(file.size).toBe(content.byteLength);
        await fs.writeFile(sharedFile, "later workspace edit");
        const chunks: Buffer[] = [];
        await snapshot.stream(file, async (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        expect(Buffer.concat(chunks)).toEqual(content);
        return "uploaded";
      },
    );

    expect(result).toBe("uploaded");
    await expect(readAfterScope!()).rejects.toThrow();
    await expect(fs.readFile(sharedFile, "utf8")).resolves.toBe("later workspace edit");
  });

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

  it("removes staged bytes after an upload failure", async () => {
    const workspaceDir = tempDirs.make("worker-upload-failed-");
    await fs.writeFile(path.join(workspaceDir, source.path), content);
    const failure = new Error("upload failed");
    let readAfterScope: (() => Promise<void>) | undefined;

    await expect(
      withNodeWorkerUploadSnapshot({ workspaceDir, sources: [source] }, async (snapshot) => {
        readAfterScope = () => snapshot.stream(snapshot.files[0]!, async () => {});
        await readAfterScope();
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(readAfterScope!()).rejects.toThrow();
    await expect(fs.readFile(path.join(workspaceDir, source.path))).resolves.toEqual(content);
  });
});
