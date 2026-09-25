import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureSupervisedWorkspace, readSupervisedWorkspaceFile } from "./supervised-workspace.js";

const race = vi.hoisted(() => ({ beforeRead: undefined as (() => Promise<void>) | undefined }));
vi.mock("../infra/boundary-file-read.js", async (original) => {
  const actual = await original<typeof import("../infra/boundary-file-read.js")>();
  return {
    ...actual,
    readFileDescriptorBounded: async (fd: number, maxBytes: number) => {
      await race.beforeRead?.();
      return actual.readFileDescriptorBounded(fd, maxBytes);
    },
  };
});
const dirs = createTempDirTracker();
afterEach(() => {
  race.beforeRead = undefined;
  dirs.cleanup();
});

it("bounds a file that grows after its validated descriptor was opened", async () => {
  const root = dirs.make("workflow-file-growth-");
  await fs.writeFile(`${root}/source`, "small");
  race.beforeRead = async () => {
    await fs.appendFile(`${root}/source`, "x".repeat(10000));
  };
  await expect(readSupervisedWorkspaceFile(root, "source", 16)).rejects.toThrow(/exceeds/);
});

it("rejects symbolic links, hard links, and paths outside the artifact", async () => {
  const root = dirs.make("workflow-file-boundaries-");
  const outside = dirs.make("workflow-file-outside-");
  await fs.writeFile(`${outside}/source`, "private");
  await fs.symlink(`${outside}/source`, `${root}/symlink`);
  await fs.link(`${outside}/source`, `${root}/hardlink`);
  for (const selected of ["symlink", "hardlink", `${outside}/source`]) {
    await expect(readSupervisedWorkspaceFile(root, selected, 100)).rejects.toThrow(/boundary/);
  }
});

it("keeps empty files and exact-boundary binary bytes in the captured artifact", async () => {
  const root = dirs.make("workflow-file-bytes-");
  await fs.writeFile(`${root}/empty`, "");
  await fs.writeFile(`${root}/binary`, Buffer.from([0, 255, 10, 128]));
  expect(await readSupervisedWorkspaceFile(root, "empty", 0)).toHaveLength(0);
  expect(await readSupervisedWorkspaceFile(root, "binary", 4)).toEqual(
    Buffer.from([0, 255, 10, 128]),
  );
  expect(
    (await captureSupervisedWorkspace({ workspace: root, sourcePaths: ["."] })).files.map(
      ({ path, bytes }) => ({ path, bytes }),
    ),
  ).toEqual([
    { path: "binary", bytes: 4 },
    { path: "empty", bytes: 0 },
  ]);
});

it("refuses an oversized directory while enumerating rather than materializing every entry", async () => {
  const root = dirs.make("workflow-directory-budget-");
  await fs.writeFile(`${root}/entry`, "fixture");
  const [entry] = await fs.readdir(root, { withFileTypes: true });
  if (!entry) {
    throw new Error("Missing fixture entry");
  }
  const directory = await fs.opendir(root);
  await directory.close();
  let yielded = 0;
  vi.spyOn(directory, Symbol.asyncIterator).mockImplementation(async function* () {
    for (let i = 0; i < 20_100; i += 1) {
      yielded += 1;
      yield entry;
    }
    return undefined;
  });
  const opendir = vi.spyOn(fs, "opendir").mockResolvedValue(directory);
  try {
    await expect(
      captureSupervisedWorkspace({ workspace: root, sourcePaths: ["."] }),
    ).rejects.toThrow(/directory.*budget/);
    expect(yielded).toBe(20_001);
  } finally {
    opendir.mockRestore();
  }
});
