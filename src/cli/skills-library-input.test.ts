import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerSkillsLibraryCli } from "./skills-library-cli.js";

const { call, error, exit } = vi.hoisted(() => ({
  call: vi.fn<
    (method: string, opts: unknown, params: Record<string, unknown>) => Promise<unknown>
  >(),
  error: vi.fn(),
  exit: vi.fn(),
}));
vi.mock("./gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-rpc.js")>()),
  callGatewayFromCliWithTransport: call,
}));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: {
    log: vi.fn(),
    error,
    exit,
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
}));

async function parseLibraryInput(input: string, zip = false) {
  const program = new Command().exitOverride();
  registerSkillsLibraryCli(program.command("skills"));
  await program.parseAsync(
    ["skills", "library", zip ? "import" : "create", input, "--slug", "skill", "--json"],
    { from: "user" },
  );
}

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
  error.mockReset();
  exit.mockReset();
  call.mockImplementation(async (_method, _opts, params) => {
    if (params.action === "begin") {
      return { uploadId: "upload", offset: 0, maxChunkBytes: MIB };
    }
    if (params.action === "chunk") {
      return { offset: Number(params.offset) + Buffer.from(String(params.data), "base64").length };
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
    await parseLibraryInput(directory);
    expect(call.mock.calls[0]?.[2].files).toHaveLength(255);
    expect(error).not.toHaveBeenCalled();

    await fs.writeFile(path.join(directory, "extra.txt"), "");
    call.mockClear();
    await parseLibraryInput(directory);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("256-file limit"));
    expect(exit).toHaveBeenCalledWith(1);
    expect(call).not.toHaveBeenCalled();
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

    await parseLibraryInput(path.join(alias, "bundle"));

    expect(error).not.toHaveBeenCalled();
    expect(call.mock.calls[0]?.[2].content).toBe("skill\r\n");
    expect(call.mock.calls[0]?.[2].files).toEqual([
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
  ])(
    "rejects $kind input that $change after metadata capture",
    async ({ kind, bytes, error: expectedError }) => {
      const directory = tempDirs.make("skills-library-admission-");
      const file = path.join(
        directory,
        kind === "zip" ? "skill.zip" : kind === "bundle" ? "00-grown.bin" : "SKILL.md",
      );
      await fs.writeFile(
        file,
        kind === "zip"
          ? "zip"
          : kind === "bundle"
            ? "x"
            : bytes === undefined
              ? "original"
              : "skill",
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
      await parseLibraryInput(kind === "bundle" ? directory : file, kind === "zip");
      expect(error).toHaveBeenCalledWith(expect.stringMatching(expectedError));
      expect(exit).toHaveBeenCalledWith(1);
      expect(mutation).toHaveBeenCalledTimes(1);
      expect(call).not.toHaveBeenCalled();
    },
  );
});
