import assert from "node:assert/strict";
import { isMainThread } from "node:worker_threads";
import { ManagedWorktreeService } from "./service.js";

assert.ok(isMainThread, "Worktree GC regression requires the Node main thread");
const now = Number(process.argv[2]);
assert.ok(Number.isSafeInteger(now), "Worktree GC fixture requires its test clock");
const service = new ManagedWorktreeService({ now: () => now });
console.log(JSON.stringify(await service.gc()));
