import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readWorkspaceFileWithGuards } from "./workspace-file-read.js";
import { loadWorkspaceBootstrapFiles } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("loads current bootstrap bytes without synchronous host path admission", async () => {
  expect(isMainThread).toBe(true);
  const workspaceDir = await fs.realpath(tempDirs.make("bootstrap-read-worker-"));
  const filePath = path.join(workspaceDir, "AGENTS.md");
  await fs.writeFile(filePath, "original instructions");
  const spies = [vi.spyOn(syncFs, "lstatSync"), vi.spyOn(syncFs.realpathSync, "native")];
  const load = async (content: string) => {
    const [file] = await loadWorkspaceBootstrapFiles(workspaceDir, ["AGENTS.md"]);
    expect(file).toMatchObject({ content, missing: false });
  };
  await load("original instructions");
  await fs.writeFile(filePath, "updated instructions");
  await load("updated instructions");
  expect(
    spies
      .flatMap((spy) => spy.mock.calls.map(([target]) => String(target)))
      .filter(
        (target) => target === workspaceDir || target.startsWith(`${workspaceDir}${path.sep}`),
      ),
  ).toEqual([]);
});

it("rereads same-size edits with restored mtime and replaced files", async () => {
  const workspaceDir = tempDirs.make("bootstrap-read-fresh-");
  const filePath = path.join(workspaceDir, "AGENTS.md");
  await fs.writeFile(filePath, "old guidance");
  const cleanTime = new Date(Math.floor(Date.now() / 1000) * 1000);
  await fs.utimes(filePath, cleanTime, cleanTime);
  const before = await fs.stat(filePath);
  const read = () => readWorkspaceFileWithGuards({ workspaceDir, filePath });
  await expect(read()).resolves.toMatchObject({ ok: true, content: "old guidance" });
  await fs.writeFile(filePath, "new guidance");
  await fs.utimes(filePath, before.atime, before.mtime);
  const after = await fs.stat(filePath);
  expect(after).toMatchObject({
    dev: before.dev,
    ino: before.ino,
    size: before.size,
    mtimeMs: before.mtimeMs,
  });
  await expect(read()).resolves.toMatchObject({ ok: true, content: "new guidance" });
  const replacement = path.join(workspaceDir, "replacement");
  await fs.writeFile(replacement, "replacement guidance");
  await fs.rename(replacement, filePath);
  await expect(read()).resolves.toMatchObject({ ok: true, content: "replacement guidance" });
});

it("retains exact source identity across canonical workspace aliases", async () => {
  const root = tempDirs.make("bootstrap-read-identity-");
  const workspaceDir = path.join(root, "workspace");
  const alias = path.join(root, "alias");
  await fs.mkdir(workspaceDir);
  await fs.symlink(workspaceDir, alias, process.platform === "win32" ? "junction" : "dir");
  await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "shared guidance");
  const actual = await readWorkspaceFileWithGuards({
    workspaceDir,
    filePath: path.join(workspaceDir, "AGENTS.md"),
  });
  const aliased = await readWorkspaceFileWithGuards({
    workspaceDir: alias,
    filePath: path.join(alias, "AGENTS.md"),
  });
  expect(actual).toMatchObject({ ok: true, content: "shared guidance" });
  expect(aliased).toEqual(actual);
  if (actual.ok) {
    expect(typeof actual.sourceIdentity[1]?.dev).toBe("bigint");
    expect(typeof actual.sourceIdentity[1]?.ino).toBe("bigint");
  }
});
