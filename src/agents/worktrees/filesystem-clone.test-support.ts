import path from "node:path";
import { afterEach, assert, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { detectWorktreeFilesystemBackend } from "./filesystem-backend.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";

export const cloneOptions = { commitGuard: () => {} };

export function useCloneFixture(id: "apfs" | "refs", parent?: string) {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => vi.restoreAllMocks());
  const makeRoot = () => dirs.make(`openclaw-${id}-`, parent);
  const create = async () => {
    const root = makeRoot();
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const backend = await detectWorktreeFilesystemBackend(root, cloneOptions);
    assert(backend);
    expect(backend.id).toBe(id);
    await backend.createTemplate(source, cloneOptions);
    return {
      root,
      source,
      destination,
      backend,
      from: (name: string) => path.join(source, name),
      to: (name: string) => path.join(destination, name),
      clone: (options: WorktreeFilesystemOptions = cloneOptions) =>
        backend.cloneTemplate(source, destination, options),
    };
  };
  return { create, makeRoot };
}

export function revocableAuthority() {
  let authorized = true;
  return {
    revoke: () => {
      authorized = false;
    },
    commitGuard: () => {
      if (!authorized) {
        throw new Error("allocation lease lost");
      }
    },
  };
}
