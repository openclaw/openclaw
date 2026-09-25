import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  harvestSupervisedCommandWorkspace,
  prepareSupervisedCommandWorkspace,
  supervisedCommandWorkspaceMountArgs,
} from "./supervised-command-workspace.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";

// This suite exercises the trusted file boundary without mounting or launching
// anything. Kernel byte/inode enforcement requires the separate isolated proof.
const command = vi.hoisted(() =>
  vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, "", ""),
  ),
);
vi.mock("node:child_process", () => ({ execFile: command }));
const dirs = createTempDirTracker();
beforeEach(() => {
  const readlink = fs.readlink;
  vi.spyOn(fs, "readlink").mockImplementation(async (file, options) =>
    file === "/proc/self/ns/mnt" ? "mnt:[2]" : await readlink(file, options),
  );
  command.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  dirs.cleanup();
});

async function fixture() {
  const root = dirs.make("bounded-command-workspace-");
  const workspace = path.join(root, "source");
  const executable = path.join(root, "executable");
  const oracle = path.join(root, "oracle");
  await fs.mkdir(workspace, { mode: 0o700 });
  await fs.writeFile(path.join(workspace, "old.txt"), "original");
  await fs.writeFile(executable, "accepted executable");
  await fs.writeFile(oracle, "accepted oracle");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const { contract } = encodeSupervisedWorkflowContract({
    version: 1,
    workspace,
    sourcePaths: ["."],
    profiles: [
      {
        kind: "command",
        id: "check",
        executable,
        executableSha256: hash("accepted executable"),
        argv: [],
        cwd: ".",
        timeoutMs: 1000,
        writable: true,
        readOnlyPaths: [{ path: oracle, sha256: hash("accepted oracle") }],
      },
    ],
    acceptance: [{ kind: "receipts", criterionId: "pass", profiles: ["check"] }],
  });
  const profile = contract.profiles[0];
  if (profile?.kind !== "command") {
    throw new Error("Expected command fixture");
  }
  const oracleInput = profile.readOnlyPaths[0];
  if (!oracleInput) {
    throw new Error("Expected oracle fixture");
  }
  const allocationId = randomUUID();
  const reservedRoot = path.join(root, allocationId);
  await fs.mkdir(reservedRoot, { mode: 0o700 });
  return {
    contract,
    profile,
    oracleInput,
    allocationId,
    reservedRoot,
    parentMountNamespace: "mnt:[1]",
    workingBytes: 64 * 1024 * 1024,
    workingInodes: 32768,
    assertCurrent: vi.fn(),
  };
}

describe.skipIf(process.platform !== "linux")("bounded command custodian file boundary", () => {
  it("refuses the host mount namespace before any mount or allocation write", async () => {
    const params = await fixture();
    params.parentMountNamespace = "mnt:[2]";
    await expect(prepareSupervisedCommandWorkspace(params)).rejects.toThrow(
      /private mount namespace/,
    );
    expect(command).not.toHaveBeenCalled();
    expect(await fs.readdir(params.reservedRoot)).toEqual([]);
  });

  it("refuses reused or redirected allocation directories before mounting", async () => {
    const params = await fixture();
    await fs.writeFile(path.join(params.reservedRoot, "owned"), "keep");
    await expect(prepareSupervisedCommandWorkspace(params)).rejects.toThrow(/already used/);
    expect(command).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(params.reservedRoot, "owned"), "utf8")).toBe("keep");
    const aliasParent = dirs.make("bounded-command-alias-");
    const alias = path.join(aliasParent, params.allocationId);
    await fs.symlink(params.reservedRoot, alias);
    await expect(
      prepareSupervisedCommandWorkspace({ ...params, reservedRoot: alias }),
    ).rejects.toThrow(/canonical private/);
    expect(command).not.toHaveBeenCalled();
  });

  it("freezes accepted input bytes and never exposes host export as writable payload storage", async () => {
    const params = await fixture();
    const prepared = await prepareSupervisedCommandWorkspace(params);
    await fs.writeFile(params.profile.executable, "changed executable");
    await fs.writeFile(params.oracleInput.path, "changed oracle");
    const executable = prepared.bindMounts.find((entry) => entry.target === "/runtime/command")!;
    const oracle = prepared.bindMounts.find((entry) => entry.target === params.oracleInput.path)!;
    expect(await fs.readFile(executable.source, "utf8")).toBe("accepted executable");
    expect(await fs.readFile(oracle.source, "utf8")).toBe("accepted oracle");
    expect(executable.writable).toBe(false);
    expect(oracle.writable).toBe(false);
    const writable = prepared.bindMounts.filter((entry) => entry.writable);
    expect(writable.map((entry) => entry.target).toSorted()).toEqual([
      "/dev/shm",
      "/home",
      "/tmp",
      "/work",
    ]);
    expect(new Set(writable.map((entry) => path.dirname(entry.source)))).toEqual(
      new Set([path.join(params.reservedRoot, "working")]),
    );
    expect(
      prepared.bindMounts.some(
        (entry) =>
          entry.source === params.contract.workspace || entry.source === params.reservedRoot,
      ),
    ).toBe(false);
    expect(supervisedCommandWorkspaceMountArgs(prepared).slice(-4)).toEqual([
      "--remount-ro",
      "/dev",
      "--remount-ro",
      "/",
    ]);
  });

  it.each(["digest", "symlink", "hardlink"])(
    "rejects an oracle %s violation before returning launch ingredients",
    async (violation) => {
      const params = await fixture();
      const oracle = params.oracleInput.path;
      if (violation === "digest") {
        await fs.writeFile(oracle, "replaced");
      } else if (violation === "hardlink") {
        await fs.link(oracle, `${oracle}-alias`);
      } else {
        await fs.rename(oracle, `${oracle}-original`);
        await fs.symlink(`${oracle}-original`, oracle);
      }
      await expect(prepareSupervisedCommandWorkspace(params)).rejects.toThrow(
        /pinned digest|regular-file boundary/,
      );
    },
  );

  it("exports deletions and accepted files without modifying the original or copying excluded caches", async () => {
    const params = await fixture();
    const prepared = await prepareSupervisedCommandWorkspace(params);
    await fs.unlink(path.join(prepared.workspace, "old.txt"));
    await fs.writeFile(path.join(prepared.workspace, "new.txt"), "new source");
    await fs.mkdir(path.join(prepared.workspace, "node_modules"));
    await fs.writeFile(path.join(prepared.workspace, "node_modules", "discard"), "cache");
    const assertPayloadExtinct = vi.fn(async () => {});
    const result = await harvestSupervisedCommandWorkspace({
      prepared,
      assertPayloadExtinct,
      assertCurrent: params.assertCurrent,
    });
    expect(assertPayloadExtinct).toHaveBeenCalledOnce();
    expect(result.snapshot.files.map((file) => file.path)).toEqual(["new.txt"]);
    expect(await fs.readdir(result.workspace)).toEqual(["new.txt"]);
    expect(await fs.readFile(path.join(result.workspace, "new.txt"), "utf8")).toBe("new source");
    expect(await fs.readFile(path.join(params.contract.workspace, "old.txt"), "utf8")).toBe(
      "original",
    );
    await expect(
      harvestSupervisedCommandWorkspace({
        prepared,
        assertPayloadExtinct,
        assertCurrent: params.assertCurrent,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it.each(["symlink", "hardlink"])(
    "rejects %s output before writing a host export",
    async (kind) => {
      const params = await fixture();
      const prepared = await prepareSupervisedCommandWorkspace(params);
      const selected = path.join(prepared.workspace, "escape");
      if (kind === "symlink") {
        await fs.symlink(params.profile.executable, selected);
      } else {
        await fs.link(path.join(prepared.workspace, "old.txt"), selected);
      }
      await expect(
        harvestSupervisedCommandWorkspace({
          prepared,
          assertPayloadExtinct: async () => {},
          assertCurrent: params.assertCurrent,
        }),
      ).rejects.toThrow(/symbolic link|regular-file limits/);
      await expect(fs.lstat(path.join(params.reservedRoot, "export"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("does not inspect or export output without extinction and current authority", async () => {
    const params = await fixture();
    const prepared = await prepareSupervisedCommandWorkspace(params);
    const assertPayloadExtinct = vi.fn(async () => {
      throw new Error("payload still alive");
    });
    command.mockClear();
    await expect(
      harvestSupervisedCommandWorkspace({
        prepared,
        assertPayloadExtinct,
        assertCurrent: params.assertCurrent,
      }),
    ).rejects.toThrow("payload still alive");
    expect(command).not.toHaveBeenCalled();
    let current = true;
    await expect(
      harvestSupervisedCommandWorkspace({
        prepared,
        assertPayloadExtinct: async () => {
          current = false;
        },
        assertCurrent: () => {
          if (!current) {
            throw new Error("owner replaced");
          }
        },
      }),
    ).rejects.toThrow("owner replaced");
    expect(command).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(params.reservedRoot, "export"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
