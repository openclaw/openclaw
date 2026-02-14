import { describe, expect, it } from "vitest";
import { findRoutedCommand } from "./routes.js";

describe("program routes", () => {
  it("matches status route and preserves plugin loading", () => {
    const route = findRoutedCommand(["status"]);
    expect(route).not.toBeNull();
    expect(route?.loadPlugins).toBe(true);
  });

  it("returns false when status timeout flag value is missing", async () => {
    const route = findRoutedCommand(["status"]);
    expect(route).not.toBeNull();
    await expect(route?.run(["node", "openclaw", "status", "--timeout"])).resolves.toBe(false);
  });

  it("returns false for sessions route when --store value is missing", async () => {
    const route = findRoutedCommand(["sessions"]);
    expect(route).not.toBeNull();
    await expect(route?.run(["node", "openclaw", "sessions", "--store"])).resolves.toBe(false);
  });

  it("does not match unknown routes", () => {
    expect(findRoutedCommand(["definitely-not-real"])).toBeNull();
  });
});
