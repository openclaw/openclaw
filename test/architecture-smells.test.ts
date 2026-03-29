import { describe, expect, it } from "vitest";
import { collectArchitectureSmells, main } from "../scripts/check-architecture-smells.mjs";
import { createCapturedIo } from "./helpers/captured-io.js";

describe("architecture smell inventory", () => {
  it("produces stable sorted output", async () => {
    const first = await collectArchitectureSmells();
    const second = await collectArchitectureSmells();

    expect(second).toEqual(first);
    expect(
      [...first].toSorted(
        (left, right) =>
          left.category.localeCompare(right.category) ||
          left.file.localeCompare(right.file) ||
          left.line - right.line ||
          left.kind.localeCompare(right.kind) ||
          left.specifier.localeCompare(right.specifier) ||
          left.reason.localeCompare(right.reason),
      ),
    ).toEqual(first);
  });

  it("script json output matches the collector", async () => {
    const captured = createCapturedIo();
    const exitCode = await main(["--json"], captured.io);

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe("");
    expect(JSON.parse(captured.readStdout())).toEqual(await collectArchitectureSmells());
  });
});
