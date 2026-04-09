import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const registerQaLabCli = vi.hoisted(() => vi.fn());

vi.mock("../plugin-sdk/qa-lab.js", () => ({
  registerQaLabCli,
}));

describe("qa cli", () => {
  beforeEach(() => {
    registerQaLabCli.mockReset();
  });

  it("delegates qa registration through the plugin-sdk seam", async () => {
    const { registerQaCli } = await import("./qa-cli.js");
    const program = new Command();

    registerQaCli(program);
    expect(registerQaLabCli).toHaveBeenCalledWith(program);
  });
});
