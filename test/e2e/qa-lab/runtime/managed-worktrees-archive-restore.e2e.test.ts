import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type {
  SessionsFilesGetResult,
  SessionsFilesStatResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions-files.js";
import type { SessionRow } from "../../../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { SessionsCreateResult } from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type {
  WorktreeRecord,
  WorktreesListResult,
  WorktreesRemoveResult,
} from "../../../../packages/gateway-protocol/src/schema/worktrees.js";
import { GatewayClientRequestError } from "../../../../src/gateway/client.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { withRpcGateway } from "./gateway-rpc.test-support.js";
import { git, initializeRepository, readText } from "./managed-worktrees-product-proof-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Archived = {
  key: string;
  sessionId: string;
  worktree: NonNullable<SessionsCreateResult["worktree"]>;
  ref: string;
  oid: string;
};

it(
  "distinguishes restoring an archived worktree from selecting another clone",
  { timeout: 90_000 },
  async () => {
    const home = await fs.realpath(tempDirs.make("openclaw-archive-restore-"));
    await fs.mkdir(path.join(home, ".openclaw"), { mode: 0o700 });
    const { repo: upstream, baseCommit } = await initializeRepository(home, async (repo) => {
      await fs.writeFile(path.join(repo, ".gitignore"), "input.local\n");
      await fs.writeFile(path.join(repo, ".worktreeinclude"), "input.local\n");
    });
    const workspace = path.join(home, "workspace");
    await fs.mkdir(workspace);
    const source = path.join(workspace, "original");
    const candidate = path.join(workspace, "candidate");
    for (const clone of [source, candidate]) {
      await git(home, "clone", "--no-local", upstream, clone);
    }
    await fs.writeFile(path.join(source, "input.local"), "source input\n");
    const options = (root: string) => ({
      name: "archive-restore",
      skipProviders: true,
      config: () => ({ worktreeRoot: path.join(home, root) }),
    });
    const note = "draft.txt";
    const saved = "saved, not committed\n";
    let control: Archived;
    let selection: Archived;
    await withRpcGateway(home, options("old-root"), async (client) => {
      async function capture(name: string): Promise<Archived> {
        const { key, sessionId, worktree } = await client.request<SessionsCreateResult>(
          "sessions.create",
          { cwd: source, worktree: true, worktreeName: name, worktreeBaseRef: "main" },
        );
        assert(sessionId && worktree);
        await fs.writeFile(path.join(worktree.path, note), saved);
        await fs.writeFile(path.join(worktree.path, "input.local"), "saved input\n");
        await fs.chmod(path.join(worktree.path, "input.local"), 0o640);
        const removed = await client.request<WorktreesRemoveResult>("worktrees.remove", {
          id: worktree.id,
        });
        assert(removed.removed && removed.snapshotRef);
        await client.request("sessions.patch", {
          key,
          expectedSessionId: sessionId,
          archived: true,
        });
        const ref = removed.snapshotRef;
        const oid = await git(source, "rev-parse", ref);
        await git(candidate, "fetch", "--no-tags", source, `${ref}:${ref}`);
        expect(await git(candidate, "rev-parse", ref)).toBe(oid);
        expect(await git(candidate, "show", `${ref}:${note}`)).toBe(saved.trimEnd());
        return { key, sessionId, worktree, ref, oid };
      }
      control = await capture("restore-control");
      selection = await capture("clone-selection");
    });

    await withRpcGateway(home, options("new-root"), async (client) => {
      const describe = (key: string) =>
        client
          .request<{ session: SessionRow }>("sessions.describe", { key })
          .then(({ session }) => session);
      const restored = await client.request<WorktreeRecord>("worktrees.restore", {
        id: control.worktree.id,
      });
      expect(restored).toMatchObject({
        id: control.worktree.id,
        path: control.worktree.path,
        repoRoot: source,
      });
      expect(await describe(control.key)).toMatchObject({
        sessionId: control.sessionId,
        archivedAt: expect.any(Number),
      });
      await client.request("sessions.patch", {
        key: control.key,
        expectedSessionId: control.sessionId,
        archived: false,
      });
      expect(await git(restored.path, "rev-parse", "HEAD")).toBe(baseCommit);
      expect(
        await client.request("sessions.files.get", { sessionKey: control.key, path: note }),
      ).toMatchObject({ root: restored.path, file: { content: saved } });
      expect(await readText(restored.path, "input.local")).toBe("saved input\n");
      if (process.platform !== "win32") {
        expect((await fs.stat(path.join(restored.path, "input.local"))).mode & 0o777).toBe(0o640);
      }

      // Observe the managed selection, not plain-folder adoption. A fresh id is not recovery.
      let refused = false;
      try {
        await client.request("sessions.create", {
          key: selection.key,
          cwd: candidate,
          worktree: true,
          worktreeName: "clone-selection",
          worktreeBaseRef: "main",
        });
      } catch (error) {
        if (
          !(error instanceof GatewayClientRequestError) ||
          error.gatewayCode !== "INVALID_REQUEST" ||
          !error.message.includes("session worktree belongs to a different repository")
        ) {
          throw error;
        }
        refused = true;
      }
      const selected = await describe(selection.key);
      expect(selected).toMatchObject({
        sessionId: selection.sessionId,
        archivedAt: expect.any(Number),
      });
      expect(await git(source, "rev-parse", selection.ref)).toBe(selection.oid);
      if (refused) {
        expect(selected.worktree).toMatchObject({ id: selection.worktree.id, repoRoot: source });
        console.info("Archived clone selection: refused; original snapshot retained.");
        return;
      }
      expect(selected.worktree?.repoRoot).toBe(candidate);
      const { worktrees } = await client.request<WorktreesListResult>("worktrees.list", {});
      const bound = worktrees.find((record) => record.id === selected.worktree?.id);
      assert(bound);
      expect(bound).toMatchObject({
        ownerKind: "session",
        ownerId: selection.key,
        repoRoot: candidate,
      });
      expect(path.dirname(path.dirname(bound.path))).toBe(path.join(home, "new-root"));
      const sameWorktree = bound.id === selection.worktree.id;
      await client.request("sessions.patch", {
        key: selection.key,
        expectedSessionId: selection.sessionId,
        archived: false,
      });
      const { files } = await client.request<SessionsFilesStatResult>("sessions.files.stat", {
        sessionKey: selection.key,
        files: [{ path: note }],
      });
      const status = files[0]?.status;
      expect(["file", "missing"]).toContain(status);
      const recoveredNote =
        status === "file" &&
        (
          await client.request<SessionsFilesGetResult>("sessions.files.get", {
            sessionKey: selection.key,
            path: note,
          })
        ).file.content === saved;
      if (sameWorktree) {
        expect(recoveredNote).toBe(true);
      }
      console.info("Archived clone selection:", { sameWorktree, recoveredNote });
    });
  },
);
