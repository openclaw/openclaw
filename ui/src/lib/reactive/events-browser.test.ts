import { afterEach, describe, expect, it, vi } from "vitest";
import { recordLobsterVisit } from "../../components/lobster-dex.ts";
import { projectLobsterdex } from "./events-browser.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("browser projections", () => {
  it("reads the browser-local dex and retires both storage and local event observers", () => {
    const projection = projectLobsterdex();
    cleanups.push(projection.dispose);
    expect(projection.read().size).toBe(0);
    const changed = vi.fn();
    const release = projection.subscribe(changed);
    recordLobsterVisit("synthetic-red", { name: "Red" });
    expect(projection.read().get("synthetic-red")?.name).toBe("Red");
    expect(changed).toHaveBeenCalledOnce();
    localStorage.setItem(
      "openclaw.control.lobsterdex.v1",
      JSON.stringify({ "synthetic-blue": { name: "Blue" } }),
    );
    const storageEvent = new StorageEvent("storage", { key: "openclaw.control.lobsterdex.v1" });
    // The shared runner installs memory storage rather than a jsdom Storage instance.
    Object.defineProperty(storageEvent, "storageArea", { value: localStorage });
    window.dispatchEvent(storageEvent);
    expect(projection.read().get("synthetic-blue")?.name).toBe("Blue");
    release();
    projection.dispose();
    changed.mockClear();
    recordLobsterVisit("synthetic-green");
    expect(changed).not.toHaveBeenCalled();
    expect(projection.read().has("synthetic-green")).toBe(false);
  });
});
