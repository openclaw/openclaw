import { describe, expect, it } from "vitest";
import {
  collectSrcExtensionImportBoundaryInventory,
  main,
} from "../scripts/check-src-extension-import-boundary.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

describe("src extension import boundary inventory", () => {
  it("stays empty", async () => {
    expect(await collectSrcExtensionImportBoundaryInventory()).toEqual([]);
  });

  it("produces stable sorted output", async () => {
    const first = await collectSrcExtensionImportBoundaryInventory();
    const second = await collectSrcExtensionImportBoundaryInventory();

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
