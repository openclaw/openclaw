import { vi } from "vitest";

type UpdateHookPacks = (typeof import("../hooks/update.js"))["updateNpmInstalledHookPacks"];
export const updateNpmInstalledHookPacksMock = vi.fn<UpdateHookPacks>();

vi.mock("../hooks/update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/update.js")>()),
  updateNpmInstalledHookPacks: (...args: Parameters<UpdateHookPacks>) =>
    updateNpmInstalledHookPacksMock(...args),
}));

// These command tests use synthetic install paths; source publication has real-worker coverage.
vi.mock("../plugins/plugin-source-snapshot-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-source-snapshot-install.js")>()),
  preparePluginInstallSourceSnapshots: async () => ({
    sourceSnapshots: [],
    [Symbol.asyncDispose]: async () => {},
  }),
}));
vi.mock("../plugins/plugin-source-snapshot-collection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-source-snapshot-collection.js")>()),
  collectInstalledPluginSourceSnapshots: async () => {},
}));
