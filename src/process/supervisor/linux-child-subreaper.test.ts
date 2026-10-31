import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { acquireLinuxChildSubreaper } from "./linux-child-subreaper.js";

const native = vi.hoisted(() => ({
  becomeChildSubreaper: vi.fn(),
  isChildSubreaper: vi.fn(() => true),
  inspectChildWaitState: vi.fn(() => ({ kind: "none" })),
  reapChild: vi.fn(),
}));
vi.mock("@openclaw/proc-safe/reaper", () => native);
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readdirSync: () => [],
}));

const execArgv = process.execArgv;
beforeEach(() => {
  vi.clearAllMocks();
  mockProcessPlatform("linux");
  process.execArgv = [];
  vi.stubEnv("NODE_OPTIONS", "");
  vi.stubEnv("BUN_BE_BUN", undefined);
  vi.stubGlobal("__openclawStandaloneRootUrl", undefined);
});
afterEach(() => {
  process.execArgv = execArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("admits a native TypeScript process owner without installing a source loader", () => {
  const owner = acquireLinuxChildSubreaper();
  expect(owner.drain()).toBe(true);
  expect(native.becomeChildSubreaper).toHaveBeenCalledOnce();
});

it.each(["argv", "environment"])(
  "rejects startup hooks from %s before acquiring kernel ownership",
  (source) => {
    if (source === "argv") {
      process.execArgv = ["--import", "tsx"];
    } else {
      vi.stubEnv("NODE_OPTIONS", '--im"port" "file:///synthetic/source loader.mjs"');
    }
    expect(() => acquireLinuxChildSubreaper()).toThrow(/without.*source.loader/u);
    expect(native.becomeChildSubreaper).not.toHaveBeenCalled();
  },
);
