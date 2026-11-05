import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../runtime.js";
import * as gatewayRpc from "./gateway-rpc.js";
import { registerSkillsLibraryCli } from "./skills-library-cli.js";

const rpc = () => vi.mocked(gatewayRpc.callGatewayFromCliWithTransport);

async function parseLibraryInput(input: string, zip = false) {
  const program = new Command().exitOverride();
  registerSkillsLibraryCli(program.command("skills"));
  await program.parseAsync(
    ["skills", "library", zip ? "import" : "create", input, "--slug", "skill", "--json"],
    { from: "user" },
  );
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});
const MIB = 1024 * 1024;

beforeEach(() => {
  vi.spyOn(gatewayRpc, "callGatewayFromCliWithTransport").mockResolvedValue({ state: "published" });
  for (const method of ["error", "exit", "writeJson"] as const) {
    vi.spyOn(defaultRuntime, method).mockImplementation(() => {});
  }
});

function inputFixture() {
  const directory = tempDirs.make("skills-library-input-");
  const write = (name: string, data: string | Buffer, mode?: number) => {
    const file = path.join(directory, name);
    return fs.writeFile(file, data, { mode }).then(() => file);
  };
  return { directory, write };
}

function expectRejectedInput(expected: RegExp) {
  expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringMatching(expected));
  expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  expect(rpc()).not.toHaveBeenCalled();
}

function mutateBeforeFileRead(target: string, mutate: () => Promise<void>, beforeOpen = false) {
  const originalOpen = fs.open;
  const mutation = vi.fn(mutate);
  // readRegularFile captures identity before open and reads through the returned handle.
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (args[0] === target && beforeOpen && mutation.mock.calls.length === 0) {
      await mutation();
    }
    const handle = await originalOpen(...args);
    if (args[0] === target && !beforeOpen) {
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
        await mutation();
        return originalRead(...readArgs);
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  return mutation;
}

it("keeps the 256-file boundary including empty supporting files", async () => {
  const { directory, write } = inputFixture();
  await write("SKILL.md", "skill");
  for (let index = 0; index < 255; index++) {
    await write(`${index}.txt`, "");
  }
  await parseLibraryInput(directory);
  expect(rpc().mock.calls[0]?.[2]).toHaveProperty("files.length", 255);
  expect(defaultRuntime.error).not.toHaveBeenCalled();

  await write("extra.txt", "");
  rpc().mockClear();
  await parseLibraryInput(directory);
  expectRejectedInput(/256-file limit/);
});

it("preserves hardlinks, ancestor symlinks, and executable metadata", async () => {
  const { directory, write } = inputFixture();
  const bundle = path.join(directory, "parent", "bundle");
  const alias = path.join(directory, "alias");
  await fs.mkdir(bundle, { recursive: true });
  await fs.symlink(path.dirname(bundle), alias, "junction");
  await fs.writeFile(path.join(bundle, "SKILL.md"), "skill\r\n");
  const original = await write("original.bin", Buffer.from([0, 255, 13, 10]), 0o755);
  await fs.link(original, path.join(bundle, "linked.bin"));

  await parseLibraryInput(path.join(alias, "bundle"));

  expect(defaultRuntime.error).not.toHaveBeenCalled();
  expect(rpc().mock.calls[0]?.[2]).toHaveProperty("content", "skill\r\n");
  expect(rpc().mock.calls[0]?.[2]).toHaveProperty("files", [
    {
      path: "linked.bin",
      content: "AP8NCg==",
      encoding: "base64",
      executable: ((await fs.stat(original)).mode & 0o111) !== 0,
    },
  ]);
});

it.each([
  ["skill", MIB + 1, /exceeds|limit/iu],
  ["zip", 8 * MIB + 1, /exceeds|between|empty/iu],
  ["zip", 0, /exceeds|between|empty/iu],
  ["bundle", MIB, /exceeds|limit/iu],
  ["skill", undefined, /identity|changed/iu],
] as const)(
  "rejects %s input after metadata capture (%s bytes; undefined replaces inode)",
  async (kind, bytes, expectedError) => {
    const { directory, write } = inputFixture();
    const file = await write(
      kind === "zip" ? "skill.zip" : kind === "bundle" ? "00-grown.bin" : "SKILL.md",
      bytes === undefined ? "original" : "skill",
    );
    if (kind === "bundle") {
      await write("SKILL.md", "skill");
      for (let index = 1; index <= 7; index++) {
        await write(`0${index}.bin`, Buffer.alloc(MIB));
      }
    }
    const replacement = path.join(directory, "replacement.md");
    if (bytes === undefined) {
      await write("replacement.md", "replacement");
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
    expectRejectedInput(expectedError);
    expect(mutation).toHaveBeenCalledTimes(1);
  },
);
