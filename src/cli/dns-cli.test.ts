import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const { registerDnsCli } = await import("./dns-cli.js");

describe("dns cli", () => {
  it("prints setup info (no apply)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const program = new Command();
      registerDnsCli(program);
      await program.parseAsync(["dns", "setup", "--domain", "openclaw.internal"], { from: "user" });
      const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("DNS setup");
      expect(output).toContain("openclaw.internal");
    } finally {
      log.mockRestore();
    }
  });
});
