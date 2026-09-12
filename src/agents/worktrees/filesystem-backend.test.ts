import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as commandRunner from "../../process/exec.js";
import type { SpawnResult } from "../../process/exec.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";

const successfulCommand: SpawnResult = {
  stdout: "btrfs-progs",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
};

describe.skipIf(process.platform !== "linux")("worktree filesystem backend", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;
  const options = { commitGuard: () => {} };

  beforeEach(async () => {
    root = tempDirs.make("openclaw-filesystem-backend-");
    const stats = await fs.statfs(root);
    vi.spyOn(fs, "statfs").mockResolvedValue(Object.assign(stats, { type: 0x9123683e }));
  });

  afterEach(() => vi.restoreAllMocks());

  it("falls back when the native utility is missing but preserves probe cancellation", async () => {
    const command = vi
      .spyOn(commandRunner, "runCommandWithTimeout")
      .mockRejectedValueOnce(Object.assign(new Error("missing executable"), { code: "ENOENT" }));
    await expect(detectWorktreeFilesystemBackend(root, options)).resolves.toBeNull();

    const abort = new AbortController();
    command.mockImplementationOnce(async () => {
      abort.abort(new Error("allocation canceled"));
      return { ...successfulCommand, code: 1 };
    });
    await expect(
      detectWorktreeFilesystemBackend(root, { ...options, signal: abort.signal }),
    ).rejects.toThrow("allocation canceled");
  });

  it("refuses an existing snapshot destination instead of creating a nested snapshot", async () => {
    const command = vi
      .spyOn(commandRunner, "runCommandWithTimeout")
      .mockResolvedValue(successfulCommand);
    const backend = await detectWorktreeFilesystemBackend(root, options);
    expect(backend).not.toBeNull();
    command.mockClear();
    await expect(backend!.cloneTemplate(path.join(root, "source"), root, options)).rejects.toThrow(
      "destination already exists",
    );
    expect(command).not.toHaveBeenCalled();
  });

  it("does not launch a mutation when authority is revoked while checking the destination", async () => {
    const command = vi
      .spyOn(commandRunner, "runCommandWithTimeout")
      .mockResolvedValue(successfulCommand);
    const backend = await detectWorktreeFilesystemBackend(root, options);
    expect(backend).not.toBeNull();
    command.mockClear();
    let authorized = true;
    vi.spyOn(fs, "lstat").mockImplementationOnce(async () => {
      authorized = false;
      throw Object.assign(new Error("absent destination"), { code: "ENOENT" });
    });
    await expect(
      backend!.createTemplate(path.join(root, "template"), {
        commitGuard: () => {
          if (!authorized) {
            throw new Error("allocation lease lost");
          }
        },
      }),
    ).rejects.toThrow("allocation lease lost");
    expect(command).not.toHaveBeenCalled();
  });
});
