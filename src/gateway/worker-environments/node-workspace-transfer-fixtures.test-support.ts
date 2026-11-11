import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { transferOwner } from "./node-workspace-transfer.test-support.js";

export function interceptUploadFile(
  name: string,
  onOpen: (handle: FileHandle, file: string) => void | Promise<void>,
) {
  const open = fs.open.bind(fs);
  return vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const file = args[0];
    if (
      typeof file === "string" &&
      file.includes(`${path.sep}upload-`) &&
      path.basename(file) === name &&
      args[1] === "wx"
    ) {
      await onOpen(handle, file);
    }
    return handle;
  });
}

export async function transferFixture(
  root: string,
  options: Parameters<typeof createNodeWorkspaceTransferService>[0] & {
    environmentId?: string;
    sessionId?: string;
    ownerEpoch?: number;
    localPath?: string;
  } = { getOwner: () => transferOwner("session") },
) {
  const localPath = options.localPath ?? path.join(root, "workspace");
  const temporaryRoot = options.temporaryRoot ?? path.join(root, "transfers");
  await fs.mkdir(localPath);
  const service = createNodeWorkspaceTransferService({ ...options, temporaryRoot });
  const request = {
    environmentId: options.environmentId ?? "environment",
    sessionId: options.sessionId ?? "session",
    ownerEpoch: options.ownerEpoch ?? 1,
    localPath,
    isAuthorized: () => true,
  };
  return { root, localPath, temporaryRoot, service, request, files: workspaceFiles(localPath) };
}

export async function commitWorkspace(root: string, message: string) {
  await requireGit(root, ["init", "--quiet"]);
  await requireGit(root, ["config", "user.name", "Workspace Test"]);
  await requireGit(root, ["config", "user.email", "workspace@example.invalid"]);
  await requireGit(root, ["add", "."]);
  await requireGit(root, ["commit", "--quiet", "-m", message]);
}

export function workspaceFiles(root: string) {
  return {
    write: (relative: string, contents: string | Buffer) =>
      fs.writeFile(path.join(root, relative), contents),
    async expect(relative: string, expected: string | Buffer) {
      const file = path.join(root, relative);
      if (typeof expected === "string") {
        await expect(fs.readFile(file, "utf8")).resolves.toBe(expected);
      } else {
        await expect(fs.readFile(file)).resolves.toEqual(expected);
      }
    },
    async missing(relative: string) {
      await expect(fs.stat(path.join(root, relative))).rejects.toMatchObject({ code: "ENOENT" });
    },
  };
}
