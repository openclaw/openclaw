import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isMainModule } from "./is-main.js";

const detect = (overrides: Partial<Parameters<typeof isMainModule>[0]> = {}) =>
  isMainModule({
    currentFile: "/repo/dist/index.js",
    argv: ["node", "/repo/openclaw.mjs"],
    env: {},
    ...overrides,
  });
const wrapperEntryPairs = [{ wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" }];

beforeEach(() => {
  vi.spyOn(process, "cwd").mockReturnValue("/repo");
});
afterEach(() => vi.restoreAllMocks());

type EntryCase = { options: Partial<Parameters<typeof isMainModule>[0]>; expected: boolean };
it.each`
  name                      | options                                                                                                                                            | expected
  ${"direct entry"}         | ${{ argv: ["node", "/repo/dist/index.js"] }}                                                                                                       | ${true}
  ${"relative PM2 entry"}   | ${{ env: { pm_exec_path: "./dist/index.js", pm_id: "0" }, argv: ["node", "/pm2/lib/ProcessContainerFork.js"] }}                                    | ${true}
  ${"configured wrapper"}   | ${{ currentFile: "/repo/dist/entry.js", wrapperEntryPairs }}                                                                                       | ${true}
  ${"unconfigured wrapper"} | ${{ currentFile: "/repo/dist/entry.js" }}                                                                                                          | ${false}
  ${"wrong wrapper entry"}  | ${{ wrapperEntryPairs }}                                                                                                                           | ${false}
  ${"PM2 import"}           | ${{ currentFile: "/repo/node_modules/openclaw/dist/index.js", argv: ["node", "/repo/app.js"], env: { pm_exec_path: "/repo/app.js", pm_id: "0" } }} | ${false}
  ${"same basename"}        | ${{ currentFile: "/repo/node_modules/openclaw/dist/index.js", argv: ["node", "/repo/dist/index.js"] }}                                             | ${false}
  ${"no entry"}             | ${{ argv: ["node"] }}                                                                                                                              | ${false}
`("detects main module: $name", ({ options, expected }: EntryCase) => {
  expect(detect(options)).toBe(expected);
});

it("falls back to the current file directory when process.cwd is unavailable", () => {
  vi.spyOn(process, "cwd").mockImplementation(() => {
    throw Object.assign(new Error("uv_cwd"), { code: "ENOENT", syscall: "uv_cwd" });
  });
  expect(detect({ argv: ["node", "/repo/dist/index.js"] })).toBe(true);
});
