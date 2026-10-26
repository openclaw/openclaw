import path from "node:path";
import { expect, it, vi } from "vitest";

const { select } = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("./bun-sqlite-library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bun-sqlite-library.js")>()),
  ensureSqliteLibrarySelected: select,
}));
vi.mock("node:sqlite", async (importOriginal) => {
  expect(select).toHaveBeenCalledOnce();
  return await importOriginal<typeof import("node:sqlite")>();
});

import { readRuntimeProbeInfo } from "./daemon-runtime-probe.js";

it("reports the selected library as an absolute path before returning capabilities", async () => {
  const selected = "custom homebrew/opt/sqlite/lib/libsqlite3.dylib";
  select.mockReturnValue({ source: "env", path: selected });
  const result = await readRuntimeProbeInfo("bun", "/artifact/runtime");
  expect(result).toMatchObject({
    sqliteLibraryPath: path.resolve(selected),
    sqliteSelectionError: null,
    sqliteProbe: { available: true },
  });
  expect(select).toHaveBeenCalledExactlyOnceWith({ standaloneRoot: "/artifact/runtime" });
});
