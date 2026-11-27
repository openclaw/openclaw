import { expect, it, vi } from "vitest";

const { metadataOwnerLoaded, snapshotImplementationLoaded } = vi.hoisted(() => ({
  metadataOwnerLoaded: vi.fn(),
  snapshotImplementationLoaded: vi.fn(),
}));
vi.mock("./sqlite-readonly-location.js", async (importOriginal) => {
  const snapshot = await importOriginal<typeof import("./sqlite-readonly-location.js")>();
  snapshotImplementationLoaded();
  return snapshot;
});
vi.mock("./gateway-state-owner.js", async (importOriginal) => {
  const owner = await importOriginal<typeof import("./gateway-state-owner.js")>();
  metadataOwnerLoaded();
  return owner;
});

it("loads snapshot and metadata owners only on inspection", async () => {
  await import("./sqlite-readonly-location.worker.js");
  expect(snapshotImplementationLoaded).not.toHaveBeenCalled();
  expect(metadataOwnerLoaded).not.toHaveBeenCalled();

  await import("./sqlite-readonly-location.inspection.js");
  expect(snapshotImplementationLoaded).toHaveBeenCalledOnce();
  expect(metadataOwnerLoaded).not.toHaveBeenCalled();

  await import("./sqlite-live-owner.js");
  expect(metadataOwnerLoaded).toHaveBeenCalledOnce();
});
