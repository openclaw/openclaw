import { expect, it } from "vitest";
import { getSqliteRuntimeCapabilities } from "../../src/infra/bun-sqlite-library.js";

const capabilitiesAtCollection = getSqliteRuntimeCapabilities();

it("settles SQLite close admission before test collection", () => {
  // A negative probe is valid; missing admission would permanently disable worker reuse.
  expect(capabilitiesAtCollection.decided).toBe(true);
});
