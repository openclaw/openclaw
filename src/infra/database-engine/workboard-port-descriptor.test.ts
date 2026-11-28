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

it("retains the exact version-4 Workboard schema for PostgreSQL recovery", async () => {
  vi.mocked(resolveBundledPluginsDir).mockReturnValue(
    fileURLToPath(new URL("../../../dist/extensions/", import.meta.url)),
  );
  const current = await loadDescriptor();
  const historical = await loadDescriptor(4);

  expect(current.preData).toContain('"common_work_json" text COLLATE "C"');
  expect(historical).toMatchObject({ version: 4 });
  expect(historical.preData).not.toContain("common_work_json");
  expect(
    historical.tables
      .find((table) => table.name === "workboard_cards")
      ?.columns.some((column) => column.name === "common_work_json"),
  ).toBe(false);
  expect(
    historical.expectedCatalog.some(
      (fact) =>
        fact.table === "workboard_cards" &&
        fact.kind === "column" &&
        typeof fact.value === "object" &&
        fact.value !== null &&
        "name" in fact.value &&
        fact.value.name === "common_work_json",
    ),
  ).toBe(false);
});
