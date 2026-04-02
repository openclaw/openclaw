import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrimaryCommand } from "../argv.js";
import { buildProgram } from "./build-program.js";
import { registerSubCliByName } from "./register.subclis.js";

describe("cron nested --help (run-main style)", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("after registerSubCliByName, cron add --help lists add options (not only the lazy cron stub)", async () => {
    const argv = ["node", "openclaw", "cron", "add", "--help"];

    const program = buildProgram(argv);
    program.exitOverride();

    const primary = getPrimaryCommand(argv);
    expect(primary).toBe("cron");

    await registerSubCliByName(program, primary);

    let helpText = "";
    const write = process.stdout.write as ReturnType<typeof vi.spyOn>;
    write.mockImplementation((chunk: string | Uint8Array) => {
      helpText += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });

    try {
      await program.parseAsync(argv);
    } catch {
      /* Commander exits help via throw when exitOverride is set */
    }

    expect(helpText).toContain("Add a cron job");
    expect(helpText).toMatch(/cron add\|create/u);
    expect(helpText).toMatch(/--name <name>/u);
  });
});
