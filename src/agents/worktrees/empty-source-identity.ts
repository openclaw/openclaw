import { createHash } from "node:crypto";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const EMPTY_WORKTREE_INITIAL_COMMIT = `tree ${EMPTY_TREE}\nauthor OpenClaw <openclaw@localhost> 0 +0000\ncommitter OpenClaw <openclaw@localhost> 0 +0000\n\nEmpty workspace\n`;
export const EMPTY_WORKTREE_INITIAL_COMMIT_ID = createHash("sha1")
  .update(
    `commit ${Buffer.byteLength(EMPTY_WORKTREE_INITIAL_COMMIT)}\0${EMPTY_WORKTREE_INITIAL_COMMIT}`,
  )
  .digest("hex");
