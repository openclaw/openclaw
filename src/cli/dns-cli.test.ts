import { describe, expect, it, vi } from "vitest";

const { buildProgram } = await import("./program.js");

describe("dns cli", () => {
  it("prints setup info (no apply)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = buildProgram();
    await program.parseAsync(["dns", "setup"], { from: "user" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Domain:"));
  });
});
