import { afterEach, describe, expect, it } from "vitest";
import {
  clearTelegramDispatchActive,
  isTelegramDispatchActive,
  markTelegramDispatchActive,
} from "./active-dispatches.js";

describe("active-dispatches", () => {
  afterEach(() => {
    // Clean up any active dispatches from tests
    clearTelegramDispatchActive("telegram:123");
    clearTelegramDispatchActive("telegram:456");
  });

  it("marks and clears dispatches", () => {
    expect(isTelegramDispatchActive("telegram:123")).toBe(false);
    markTelegramDispatchActive("telegram:123");
    expect(isTelegramDispatchActive("telegram:123")).toBe(true);
    clearTelegramDispatchActive("telegram:123");
    expect(isTelegramDispatchActive("telegram:123")).toBe(false);
  });

  it("tracks different keys independently", () => {
    markTelegramDispatchActive("telegram:123");
    expect(isTelegramDispatchActive("telegram:123")).toBe(true);
    expect(isTelegramDispatchActive("telegram:456")).toBe(false);
  });

  it("clearing a non-existent key is safe", () => {
    clearTelegramDispatchActive("telegram:999");
    expect(isTelegramDispatchActive("telegram:999")).toBe(false);
  });
});
