import { expect, it, vi } from "vitest";

const metadataOwnerLoaded = vi.hoisted(() => vi.fn());
vi.mock("./gateway-state-owner.js", async (importOriginal) => {
  const owner = await importOriginal<typeof import("./gateway-state-owner.js")>();
  metadataOwnerLoaded();
  return owner;
});

it("keeps metadata ownership checks out of read-only worker startup", async () => {
  await import("./sqlite-readonly-location.worker.js");
  expect(metadataOwnerLoaded).not.toHaveBeenCalled();

  await import("./sqlite-live-owner.js");
  expect(metadataOwnerLoaded).toHaveBeenCalledOnce();
});
