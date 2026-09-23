import assert from "node:assert/strict";
import { isMainThread } from "node:worker_threads";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { ManagedWorktreeService } from "./service.js";

assert.ok(isMainThread, "Worktree GC regression requires the Node main thread");
const now = Number(process.argv[2]);
assert.ok(Number.isSafeInteger(now), "Worktree GC fixture requires its test clock");
const service = new ManagedWorktreeService({ now: () => now });
try {
  console.log(JSON.stringify(await service.gc()));
} finally {
  await closeOpenClawStateDatabaseAsync();
}
