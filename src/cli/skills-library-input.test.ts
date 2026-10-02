import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readLibraryInput, uploadLibraryZip } from "./skills-library-input.js";

const call = vi.hoisted(() => vi.fn());
vi.mock("./gateway-rpc.js", () => ({ callGatewayFromCliWithTransport: call }));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    cleanup();
  }),
);
const MIB = 1024 * 1024;

beforeEach(() => {
  call.mockReset();
  call.mockImplementation(async (_method, _opts, params) => {
    if (params.action === "begin") {
      return { uploadId: "upload", offset: 0, maxChunkBytes: MIB };
    }
    if (params.action === "chunk") {
      return { offset: params.offset + Buffer.from(params.data, "base64").length };
    }
    return { state: "published" };
  });
});

function mutateBeforeFileRead(target: string, mutate: () => Promise<void>, beforeOpen = false) {
  const originalReadFile = fs.readFile;
  const originalOpen = fs.open;
  const mutation = vi.fn(mutate);
  let changed = false;
  const changeOnce = async () => {
    if (!changed) {
      changed = true;
      await mutation();
    }
  };
  // Cover pathname reads and borrowed-handle reads without replacing their real I/O.
  vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
    if (args[0] === target) {
      await changeOnce();
    }
    return originalReadFile(...args);
  });
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (args[0] === target && beforeOpen) {
      await changeOnce();
    }
    const handle = await originalOpen(...args);
    if (args[0] === target && !beforeOpen) {
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
        await changeOnce();
        return originalRead(...readArgs);
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  return mutation;
}

async function captureReadFailure(operation: () => Promise<unknown>): Promise<unknown> {
  return operation().then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("skills library file admission", () => {
  it("keeps the 256-file boundary including empty supporting files", async () => {
    const directory = tempDirs.make("skills-library-count-");
    await fs.writeFile(path.join(directory, "SKILL.md"), "skill");
    for (let index = 0; index < 255; index++) {
      await fs.writeFile(path.join(directory, `${index}.txt`), "");
    }
    const bundle = await readLibraryInput(directory);
    expect(bundle.files).toHaveLength(255);

    await fs.writeFile(path.join(directory, "extra.txt"), "");
    await expect(readLibraryInput(directory)).rejects.toThrow("256-file limit");
  });

  it("preserves hardlinks, ancestor symlinks, and executable metadata", async () => {
    const directory = tempDirs.make("skills-library-aliases-");
    const parent = path.join(directory, "parent");
    const bundle = path.join(parent, "bundle");
    const alias = path.join(directory, "alias");
    await fs.mkdir(bundle, { recursive: true });
    await fs.symlink(parent, alias, "junction");
    await fs.writeFile(path.join(bundle, "SKILL.md"), "skill\r\n");
    const original = path.join(directory, "original.bin");
    await fs.writeFile(original, Buffer.from([0, 255, 13, 10]), { mode: 0o755 });
    await fs.link(original, path.join(bundle, "linked.bin"));

    const result = await readLibraryInput(path.join(alias, "bundle"));

    expect(result.content).toBe("skill\r\n");
    expect(result.files).toEqual([
      {
        path: "linked.bin",
        content: "AP8NCg==",
        encoding: "base64",
        executable: ((await fs.stat(original)).mode & 0o111) !== 0,
      },
    ]);
  });

  it("rejects a skill file that grows beyond 1 MiB after metadata capture", async () => {
    const directory = tempDirs.make("skills-library-growth-");
    const file = path.join(directory, "SKILL.md");
    await fs.writeFile(file, "skill");
    const mutation = mutateBeforeFileRead(file, () => fs.writeFile(file, Buffer.alloc(MIB + 1)));

    const error = await captureReadFailure(() => readLibraryInput(file));

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ message: expect.stringMatching(/exceeds|limit/iu) });
  });

  it.each([
    { name: "grows beyond 8 MiB", bytes: 8 * MIB + 1 },
    { name: "becomes empty", bytes: 0 },
  ])("rejects a ZIP that $name before starting an upload", async ({ bytes }) => {
    const directory = tempDirs.make("skills-library-zip-");
    const file = path.join(directory, "skill.zip");
    await fs.writeFile(file, "zip");
    const mutation = mutateBeforeFileRead(file, () => fs.writeFile(file, Buffer.alloc(bytes)));

    const error = await captureReadFailure(() => uploadLibraryZip(file, "skill", {}));

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ message: expect.stringMatching(/exceeds|between|empty/iu) });
    expect(call).not.toHaveBeenCalled();
  });

  it("counts bytes actually read toward the 8 MiB bundle limit", async () => {
    const directory = tempDirs.make("skills-library-total-");
    const grown = path.join(directory, "00-grown.bin");
    await fs.writeFile(grown, "x");
    await fs.writeFile(path.join(directory, "SKILL.md"), "skill");
    for (let index = 1; index <= 7; index++) {
      await fs.writeFile(path.join(directory, `0${index}.bin`), Buffer.alloc(MIB));
    }
    const mutation = mutateBeforeFileRead(grown, () => fs.writeFile(grown, Buffer.alloc(MIB)));

    const error = await captureReadFailure(() => readLibraryInput(directory));

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ message: expect.stringMatching(/exceeds|limit/iu) });
  });

  it("rejects an input replaced by another inode after preview", async () => {
    const directory = tempDirs.make("skills-library-replaced-");
    const file = path.join(directory, "SKILL.md");
    const replacement = path.join(directory, "replacement.md");
    await fs.writeFile(file, "original");
    await fs.writeFile(replacement, "replacement");
    const mutation = mutateBeforeFileRead(file, () => fs.rename(replacement, file), true);

    const error = await captureReadFailure(() => readLibraryInput(file));

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ message: expect.stringMatching(/identity|changed/iu) });
  });
});
