import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("./database-engine/open.js");
  vi.doUnmock("../utils/delivery-context.shared.js");
  vi.resetModules();
});

it("loads the isolated physical reader without native engine opening", async () => {
  vi.resetModules();
  // mock-isolation: Count forbidden cold loading, not the separate child-owned inspection.
  vi.doMock("./database-engine/open.js", () => {
    throw new Error("physical reader loaded native engine opening");
  });
  const { readBackupEngine } = await import("./database-engine/physical-store.js");
  expect(readBackupEngine).toBeTypeOf("function");
});

it("checks canonical session entry state without loading delivery routing", async () => {
  vi.resetModules();
  // mock-isolation: Format detection does not normalize or deliver a channel route.
  vi.doMock("../utils/delivery-context.shared.js", () => {
    throw new Error("canonical entry detection loaded delivery routing");
  });
  const { hasLegacySessionProviderState } =
    await import("../config/sessions/session-entry-state-format.js");
  expect(hasLegacySessionProviderState({ provider: "telegram" })).toBe(true);
  expect(hasLegacySessionProviderState({ provider: "telegram", delivery: { kind: "none" } })).toBe(
    false,
  );
});
