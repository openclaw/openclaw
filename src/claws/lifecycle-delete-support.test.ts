import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { removeClawWorkspaceFile } from "./lifecycle-delete-support.js";

const fsSafeRoot = vi.hoisted(() => vi.fn());
vi.mock("@openclaw/fs-safe/root", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/root")>()),
  root: fsSafeRoot,
}));

describe("Claw workspace file removal authority", () => {
  it("rechecks live authority at fs-safe mutation dispatch", async () => {
    let current = true;
    const readBytes = vi.fn(async () => Buffer.from("owned file"));
    const move = vi.fn(
      async (_from: string, _to: string, options?: { assertBeforeMutation?: () => void }) => {
        current = false;
        options?.assertBeforeMutation?.();
      },
    );
    fsSafeRoot.mockResolvedValueOnce({
      exists: async () => true,
      move,
      readBytes,
    });

    const result = await removeClawWorkspaceFile(
      {
        workspace: "/owned/workspace",
        path: "WORKER.md",
        contentDigest: `sha256:${"0".repeat(64)}`,
        state: "unchanged",
      },
      () => {
        if (!current) {
          throw new Error("Gateway authority retired");
        }
      },
    );

    expect(result.action).toBe("error");
    expect(move).toHaveBeenCalledOnce();
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("rechecks live authority before deleting a staged file", async () => {
    let current = true;
    const content = Buffer.from("owned file");
    const move = vi.fn(async () => undefined);
    const remove = vi.fn(async (_path: string, options?: { assertBeforeMutation?: () => void }) => {
      current = false;
      options?.assertBeforeMutation?.();
    });
    fsSafeRoot.mockResolvedValueOnce({
      exists: async () => true,
      move,
      readBytes: async () => content,
      remove,
    });

    const result = await removeClawWorkspaceFile(
      {
        workspace: "/owned/workspace",
        path: "WORKER.md",
        contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        state: "unchanged",
      },
      () => {
        if (!current) {
          throw new Error("Gateway authority retired");
        }
      },
    );

    expect(result.action).toBe("error");
    expect(remove).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledTimes(2);
  });
});
