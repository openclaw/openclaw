import { expect, expectTypeOf, it, vi } from "vitest";
import { resolveCronStorePath, resolveCronStorePathAsync } from "./cron-store-runtime.js";

it("retains the synchronous cron path contract with an awaited replacement", async () => {
  expectTypeOf<typeof resolveCronStorePath>().toExtend<(storePath?: string) => string>();
  expectTypeOf<typeof resolveCronStorePathAsync>().toExtend<
    (storePath?: string) => Promise<string>
  >();
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  try {
    const path = "/tmp/cron-sdk-compat/jobs.json";
    expect(resolveCronStorePath(path)).toBe(path);
    expect(await resolveCronStorePathAsync(path)).toBe(path);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("resolveCronStorePathAsync"), {
      code: "DEP_PLUGIN_SDK",
      type: "DeprecationWarning",
    });
  } finally {
    warning.mockRestore();
  }
});
