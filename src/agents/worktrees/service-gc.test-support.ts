import assert from "node:assert/strict";
import { isMainThread } from "node:worker_threads";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { ManagedWorktreeService } from "./service.js";

assert.ok(isMainThread, "Worktree GC regression requires the Node main thread");
setRuntimeConfigSnapshot({});
const service = new ManagedWorktreeService();
console.log(JSON.stringify(await service.gc()));
