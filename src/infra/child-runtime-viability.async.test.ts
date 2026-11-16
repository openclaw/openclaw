import { expect, it } from "vitest";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import {
  formatChildRuntimeSpawnWarning,
  prepareChildRuntimeViability,
} from "./child-runtime-viability.js";

it("diagnoses a failed launch without synchronous runtime filesystem checks", async () => {
  const error = Object.assign(new Error("synthetic child launch failure"), {
    code: "EACCES",
    path: process.execPath,
  });
  let calls;
  let warning;
  {
    using filesystem = observeMainThreadFs();
    expect((await prepareChildRuntimeViability()).publish().available).toBe(true);
    warning = await formatChildRuntimeSpawnWarning(error);
    calls = filesystem.stacks().filter(({ stack }) => stack.includes("child-runtime-viability"));
  }
  expect(warning).toBeUndefined();
  expect(error).toMatchObject({ code: "EACCES", path: process.execPath });
  expect(calls).toEqual([]);
});
