import { describe, expect, it } from "vitest";
import {
  collectSdkPackageExtensionImportBoundaryInventory,
  main,
} from "../scripts/check-sdk-package-extension-import-boundary.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

describe("sdk/package extension import boundary inventory", () => {
  it("stays empty", async () => {
    expect(await collectSdkPackageExtensionImportBoundaryInventory()).toEqual([]);
  });

  it("produces stable sorted output", async () => {
    const first = await collectSdkPackageExtensionImportBoundaryInventory();
    const second = await collectSdkPackageExtensionImportBoundaryInventory();

    expect(second).toEqual(first);
  });

  it("script json output stays empty", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual([]);
  });
});
