import { isMainThread } from "node:worker_threads";
import { expect, it } from "vitest";
import { getSqliteRuntimeCapabilities } from "../../src/infra/bun-sqlite-library.js";

it.runIf(!isMainThread)("inherits settled SQLite close admission before test execution", () => {
  // A negative probe is valid; missing parent admission would permanently disable worker reuse.
  expect(getSqliteRuntimeCapabilities().decided).toBe(true);
});
