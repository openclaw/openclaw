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

  it.each([
    { kind: "skill", change: "grows beyond 1 MiB", bytes: MIB + 1, error: /exceeds|limit/iu },
    {
      kind: "zip",
      change: "grows beyond 8 MiB",
      bytes: 8 * MIB + 1,
      error: /exceeds|between|empty/iu,
    },
    { kind: "zip", change: "becomes empty", bytes: 0, error: /exceeds|between|empty/iu },
    { kind: "bundle", change: "grows beyond 8 MiB total", bytes: MIB, error: /exceeds|limit/iu },
    { kind: "skill", change: "changes inode", bytes: undefined, error: /identity|changed/iu },
  ])("rejects $kind input that $change after metadata capture", async ({ kind, bytes, error }) => {
    const directory = tempDirs.make("skills-library-admission-");
    const file = path.join(
      directory,
      kind === "zip" ? "skill.zip" : kind === "bundle" ? "00-grown.bin" : "SKILL.md",
    );
    await fs.writeFile(
      file,
      kind === "zip" ? "zip" : kind === "bundle" ? "x" : bytes === undefined ? "original" : "skill",
    );
    if (kind === "bundle") {
      await fs.writeFile(path.join(directory, "SKILL.md"), "skill");
      for (let index = 1; index <= 7; index++) {
        await fs.writeFile(path.join(directory, `0${index}.bin`), Buffer.alloc(MIB));
      }
    }
    const replacement = path.join(directory, "replacement.md");
    if (bytes === undefined) {
      await fs.writeFile(replacement, "replacement");
    }
    const mutation = mutateBeforeFileRead(
      file,
      () =>
        bytes === undefined
          ? fs.rename(replacement, file)
          : fs.writeFile(file, Buffer.alloc(bytes)),
      bytes === undefined,
    );
    const result =
      kind === "zip"
        ? uploadLibraryZip(file, "skill", {})
        : readLibraryInput(kind === "bundle" ? directory : file);
    await expect(result).rejects.toMatchObject({ message: expect.stringMatching(error) });
    expect(mutation).toHaveBeenCalledTimes(1);
    if (kind === "zip") {
      expect(call).not.toHaveBeenCalled();
    }
  });
});
