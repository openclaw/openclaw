import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";
import { loadDescriptor } from "./workboard-port-descriptor.js";

vi.mock("../../plugins/bundled-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/bundled-dir.js")>()),
  resolveBundledPluginsDir: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

it("loads port SQL from the selected Workboard API when the built plugin tree is incomplete", async () => {
  vi.mocked(resolveBundledPluginsDir).mockReturnValue(
    fileURLToPath(new URL("../../../dist/extensions/", import.meta.url)),
  );
  vi.spyOn(fs, "readFile").mockRejectedValue(
    Object.assign(new Error("Built plugin tree has no SQL asset"), { code: "ENOENT" }),
  );
  const descriptor = await loadDescriptor();
  expect(descriptor.preData).toContain('CREATE TABLE "workboard_boards"');
  expect(descriptor.postData).toContain('CREATE INDEX "workboard_cards_');
});
