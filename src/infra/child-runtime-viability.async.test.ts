import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import { formatChildRuntimeSpawnWarning } from "./child-runtime-viability.js";

it("diagnoses a failed launch without synchronous runtime filesystem checks", async () => {
  const error = Object.assign(new Error("synthetic child launch failure"), {
    code: "EACCES",
    path: process.execPath,
  });
  using access = vi.spyOn(fs, "access");
  using stat = vi.spyOn(fs, "stat");
  let calls;
  let warning;
  {
    using filesystem = observeMainThreadFs();
    warning = await formatChildRuntimeSpawnWarning(error);
    calls = filesystem.stacks().filter(({ stack }) => stack.includes("child-runtime-viability"));
  }
  expect(warning).toBeUndefined();
  expect(error).toMatchObject({ code: "EACCES", path: process.execPath });
  expect(calls).toEqual([]);
  expect(access.mock.calls.filter(([file]) => file === process.execPath)).toHaveLength(1);
  expect(stat.mock.calls.filter(([file]) => file === process.execPath)).toHaveLength(1);
});
