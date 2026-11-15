import { expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({ loads: 0 }));
// mock-isolation: Count real workspace discovery imports without replacing its implementation.
vi.mock("./workspace.js", async (importOriginal) => {
  workspace.loads++;
  return importOriginal();
});

it("keeps workspace discovery cold when no internal hooks are configured", async () => {
  const { prepareInternalHooks } = await import("./loader.js");
  const prepared = await prepareInternalHooks({}, "/synthetic/workspace", {
    selection: { configured: false, names: new Set(), declaredNames: new Set() },
  });
  expect(prepared.loadedCount).toBe(0);
  expect(prepared.commit()).toBe(true);
  expect(workspace.loads).toBe(0);
});
