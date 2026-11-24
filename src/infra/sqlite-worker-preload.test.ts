import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";

const keys = [
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  "OPENCLAW_TEST_SQLITE_WORKER_PRELOAD",
] as const;
const values = () => Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let originalEnvironment: NodeJS.ProcessEnv;
let snapshot: ReturnType<typeof captureFullEnv>;
let baseline: ReturnType<typeof values>;
beforeAll(() => {
  originalEnvironment = process.env;
  snapshot = captureFullEnv();
  baseline = values();
});

afterAll(() => {
  try {
    expect(values()).toEqual(baseline);
  } finally {
    process.env = originalEnvironment;
    snapshot.restore();
  }
});

it("restores the first preload environment after repeated calls and object replacement", () => {
  Object.assign(process.env, sqliteWorkerPreloadEnv(path.resolve("first-preload.cjs")));
  process.env = {
    ...process.env,
    ...sqliteWorkerPreloadEnv(path.resolve("second-preload.cjs")),
  };
});
