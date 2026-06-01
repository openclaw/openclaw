import { describe, expect, it } from "vitest";
import {
  listSessionEntries as listAccessorSessionEntries,
  loadSessionEntry,
} from "../config/sessions/session-accessor.js";
import { getSessionEntry, listSessionEntries } from "./session-store-runtime.js";

describe("session-store-runtime", () => {
  it("routes read helpers through the session accessor seam", () => {
    expect(getSessionEntry).toBe(loadSessionEntry);
    expect(listSessionEntries).toBe(listAccessorSessionEntries);
  });
});
