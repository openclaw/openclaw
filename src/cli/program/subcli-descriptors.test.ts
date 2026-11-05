// SubCLI descriptor tests cover metadata for registered nested command groups.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";

const execFileAsync = promisify(execFile);

async function importSubCliDescriptors() {
  vi.resetModules();
  return import("./subcli-descriptors.js");
}

function descriptorNames(descriptors: ReadonlyArray<{ name: string }>): string[] {
  return descriptors.map((descriptor) => descriptor.name);
}

describe("sub-cli descriptors", () => {
  const originalEnv = captureEnv(["OPENCLAW_ENABLE_PRIVATE_QA_CLI"]);

  afterEach(() => {
    originalEnv.restore();
    vi.resetModules();
  });

  it("cold-imports without an ESM initialization cycle", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          "await import('./src/cli/program/subcli-descriptors.ts')",
        ],
        { cwd: process.cwd(), timeout: 30_000 },
      ),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("keeps parsing metadata and registrations aligned when private QA is disabled (#83927)", async () => {
    delete process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI;

    const { getSubCliEntriesCore } = await importSubCliDescriptors();
    const { SUB_CLI_COMMAND_METADATA } = await import("./subcli-command-metadata.js");
    const metadataNames = descriptorNames(SUB_CLI_COMMAND_METADATA);

    expect(metadataNames).toEqual(descriptorNames(getSubCliEntriesCore()));
    expect(metadataNames).not.toContain("qa");
  });

  it("includes qa in parsing metadata and registrations when private QA is enabled", async () => {
    process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";

    const { getSubCliEntriesCore } = await importSubCliDescriptors();
    const { SUB_CLI_COMMAND_METADATA } = await import("./subcli-command-metadata.js");
    const metadataNames = descriptorNames(SUB_CLI_COMMAND_METADATA);

    expect(metadataNames).toEqual(descriptorNames(getSubCliEntriesCore()));
    expect(metadataNames).toContain("qa");
  });
});
