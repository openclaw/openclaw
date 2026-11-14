import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as boundaryFileRead from "../infra/boundary-file-read.js";
import { resetGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "./workspace-bootstrap-read.js";
import { readWorkspaceFileWithGuards } from "./workspace-file-read.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const initialConfig = getFsSafeNativeConfig();
afterEach(async () => {
  await resetGlobalSingletonLifecycleState(Symbol.for("openclaw.workspaceFilesystem"));
  configureFsSafeNative(initialConfig);
  vi.restoreAllMocks();
});

describe.each(["off", "auto"] as const)("uncached guarded workspace reads (%s)", (mode) => {
  it("keeps fresh content and exact identity without opening the file on the caller thread", async () => {
    configureFsSafeNative({ mode });
    const workspaceDir = tempDirs.make("workspace-read-worker-");
    const filePath = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(filePath, "first");
    const open = vi.spyOn(boundaryFileRead, "openRootFile");
    const first = await readWorkspaceFileWithGuards({ workspaceDir, filePath, useCache: false });
    expect(first).toMatchObject({ ok: true, content: "first" });
    if (!first.ok) {
      throw new Error("Expected a readable workspace file");
    }
    const stat = await fs.stat(filePath, { bigint: true });
    expect(first.sourceIdentity[1]).toMatchObject({ dev: stat.dev, ino: stat.ino });
    await fs.writeFile(filePath, "second");
    await expect(
      readWorkspaceFileWithGuards({ workspaceDir, filePath, useCache: false }),
    ).resolves.toMatchObject({ ok: true, content: "second" });
    expect(open).not.toHaveBeenCalled();
  });

  it("preserves absent and oversized read failures across the worker boundary", async () => {
    configureFsSafeNative({ mode });
    const workspaceDir = tempDirs.make("workspace-read-worker-errors-");
    const filePath = path.join(workspaceDir, "AGENTS.md");
    await expect(
      readWorkspaceFileWithGuards({ workspaceDir, filePath, useCache: false }),
    ).resolves.toMatchObject({ ok: false, reason: "path", error: { code: "ENOENT" } });
    await fs.writeFile(filePath, Buffer.alloc(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES + 1));
    const result = await readWorkspaceFileWithGuards({ workspaceDir, filePath, useCache: false });
    expect(result).toMatchObject({ ok: false, reason: "validation" });
    if (result.ok) {
      throw new Error("Expected an oversized file to be refused");
    }
    expect(result.error).toBeInstanceOf(RangeError);
  });

  it.skipIf(process.platform === "win32")(
    "refuses an alias when the caller requires the exact profile path",
    async () => {
      configureFsSafeNative({ mode });
      const workspaceDir = tempDirs.make("workspace-read-worker-alias-");
      const real = path.join(workspaceDir, "real.md");
      const filePath = path.join(workspaceDir, "USER.md");
      await fs.writeFile(real, "private instructions");
      await fs.symlink(real, filePath);
      await expect(
        readWorkspaceFileWithGuards({
          workspaceDir,
          filePath,
          useCache: false,
          rejectAliases: true,
        }),
      ).resolves.toMatchObject({ ok: false });
    },
  );
});
