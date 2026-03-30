import { describe, expect, it, vi } from "vitest";

vi.mock("./core-command-descriptors.js", () => ({
  getCoreCliCommandDescriptors: () => [
    {
      name: "status",
      description: "Show status",
      hasSubcommands: false,
    },
  ],
  getCoreCliCommandsWithSubcommands: () => [],
}));

vi.mock("./subcli-descriptors.js", () => ({
  getSubCliEntries: () => [
    {
      name: "config",
      description: "Manage config",
      hasSubcommands: true,
    },
  ],
  getSubCliCommandsWithSubcommands: () => ["config"],
}));

vi.mock("../../plugins/cli.js", () => ({
  getPluginCliCommandDescriptors: async () => [
    {
      name: "matrix",
      description: "Matrix channel utilities",
      hasSubcommands: true,
    },
  ],
}));

const { renderRootHelpText } = await import("./root-help.js");

describe("root help", () => {
  it("includes plugin CLI descriptors alongside core and sub-CLI commands", async () => {
    const text = await renderRootHelpText();

    expect(text).toContain("status");
    expect(text).toContain("config");
    expect(text).toContain("matrix");
    expect(text).toContain("Matrix channel utilities");
  });
});
