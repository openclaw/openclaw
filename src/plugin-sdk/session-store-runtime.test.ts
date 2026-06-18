import { describe, expect, it } from "vitest";
import {
  listSessionEntries as listAccessorSessionEntries,
  loadSessionEntry,
  readSessionUpdatedAt as readAccessorSessionUpdatedAt,
} from "../config/sessions/session-accessor.js";
import {
  getSessionEntry,
  listSessionEntries,
  readSessionUpdatedAt,
} from "./session-store-runtime.js";

describe("session-store-runtime", () => {
  it("routes read helpers through the session accessor seam", () => {
    expect(getSessionEntry).toBe(loadSessionEntry);
    expect(listSessionEntries).toBe(listAccessorSessionEntries);
    expect(readSessionUpdatedAt).toBe(readAccessorSessionUpdatedAt);
  });
});
