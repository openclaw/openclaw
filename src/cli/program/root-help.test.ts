import { describe, expect, it, vi } from "vitest";

vi.mock("./core-command-descriptors.js", () => ({
  getCoreCliCommandDescriptors: () => [
    {
      name: "status",
      description: "Show status",
    },
  ],
}));

vi.mock("./subcli-descriptors.js", () => ({
  getSubCliEntries: () => [
    {
      name: "config",
      description: "Manage config",
    },
  ],
}));

vi.mock("../../plugins/cli.js", () => ({
  getPluginCliCommandDescriptors: () => [
    {
      name: "matrix",
      description: "Matrix channel utilities",
      hasSubcommands: true,
    },
  ],
}));

const { renderRootHelpText } = await import("./root-help.js");

describe("root help", () => {
  it("includes plugin CLI descriptors alongside core and sub-CLI commands", () => {
    const text = renderRootHelpText();

    expect(text).toContain("status");
    expect(text).toContain("config");
    expect(text).toContain("matrix");
    expect(text).toContain("Matrix channel utilities");
  });
});
