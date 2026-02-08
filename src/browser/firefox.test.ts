import { describe, expect, it, vi } from "vitest";
import { isFirefoxReachable, getFirefoxContext } from "./firefox.js";

describe("firefox helpers", () => {
  it("isFirefoxReachable returns false when no context exists", async () => {
    expect(await isFirefoxReachable("nonexistent-profile")).toBe(false);
  });

  it("getFirefoxContext returns undefined for unknown profile", () => {
    expect(getFirefoxContext("unknown-profile")).toBeUndefined();
  });
});
