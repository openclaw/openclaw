import { afterEach, describe, expect, it, vi } from "vitest";

async function importSubCliDescriptors() {
  vi.resetModules();
  return import("./subcli-descriptors.js");
}

describe("sub-cli descriptors", () => {
  const originalPrivateQaCli = process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;

  afterEach(() => {
    if (originalPrivateQaCli === undefined) {
      delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;
    } else {
      process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = originalPrivateQaCli;
    }
    vi.resetModules();
  });

  it("keeps the exported descriptor list aligned with private QA visibility when disabled (#83927)", async () => {
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;

    const { SUB_CLI_DESCRIPTORS, getSubCliEntries } = await importSubCliDescriptors();

    expect(SUB_CLI_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual(
      getSubCliEntries().map((descriptor) => descriptor.name),
    );
    expect(SUB_CLI_DESCRIPTORS.map((descriptor) => descriptor.name)).not.toContain("qa");
  });

  it("keeps all sub-cli filter surfaces aligned when private QA is disabled (#83926)", async () => {
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;

    const {
      SUB_CLI_DESCRIPTORS,
      getSubCliCommandsWithSubcommands,
      getSubCliParentDefaultHelpCommands,
    } = await importSubCliDescriptors();

    expect(SUB_CLI_DESCRIPTORS.map((descriptor) => descriptor.name)).not.toContain("qa");
    expect(getSubCliCommandsWithSubcommands()).not.toContain("qa");
    expect(getSubCliParentDefaultHelpCommands()).not.toContain("qa");
  });

  it("includes qa in the exported descriptor list when private QA is enabled", async () => {
    process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";

    const { SUB_CLI_DESCRIPTORS, getSubCliEntries } = await importSubCliDescriptors();

    expect(SUB_CLI_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual(
      getSubCliEntries().map((descriptor) => descriptor.name),
    );
    expect(SUB_CLI_DESCRIPTORS.map((descriptor) => descriptor.name)).toContain("qa");
  });
});
