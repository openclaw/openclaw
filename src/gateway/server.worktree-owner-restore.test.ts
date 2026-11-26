import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { withMatrixGateway } from "./server.invite-scope-matrix.test-support.js";

const memberScopes = ["operator.read", "operator.sessions.write"] as const;

it("lets the session owner restore its removed worktree and refuses other members", async ({
  signal,
}) => {
  await withMatrixGateway(signal, true, async ({ admin, connect }) => {
    const owner = (await connect("creator", [...memberScopes])).client;
    // A member whose role may write other people's sessions is still not this session's owner.
    const other = (await connect("team-write", [...memberScopes])).client;
    const created = await owner.request<{ worktree: { id: string; path: string } }>(
      "sessions.create",
      { worktree: true, worktreeSource: "empty" },
    );
    const { id, path } = created.worktree;
    const removeByCleanup = async () => {
      expect(await admin.request("worktrees.remove", { id })).toMatchObject({ removed: true });
      await expect(fs.access(path)).rejects.toMatchObject({ code: "ENOENT" });
    };

    await removeByCleanup();
    await expect(other.request("worktrees.restore", { id })).rejects.toThrow(
      "Ask an administrator to restore this workspace, or start a new conversation.",
    );
    await expect(fs.access(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await owner.request("worktrees.restore", { id })).toMatchObject({ id, path });
    await fs.access(path);

    await removeByCleanup();
    expect(await admin.request("worktrees.restore", { id })).toMatchObject({ id, path });
    await fs.access(path);
  });
});
