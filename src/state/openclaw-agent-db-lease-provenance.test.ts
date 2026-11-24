import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const dirs = createTempDirTracker();
afterEach(() => {
  vi.mocked(spawnSync).mockReset();
  vi.restoreAllMocks();
  dirs.cleanup();
});

it.each([
  ["darwin", "12345678-1234-1234-1234-123456789abc"],
  ["win32", "2026-09-01T00:00:00.0000000Z"],
] as const)(
  "reads lease provenance on %s without trusting unknown boot identity",
  async (platform, identity) => {
    const pathname = path.join(dirs.make("agent-lease-provenance-"), "agent.sqlite");
    fs.writeFileSync(pathname, "synthetic database identity");
    mockProcessPlatform(platform);
    const bootResult = {
      pid: 1,
      output: [],
      stdout: Buffer.from(`${identity}\n`),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    };
    const readBoot = vi.mocked(spawnSync).mockReturnValue(bootResult);
    vi.resetModules();
    const { readAgentDatabaseLeaseProvenance } =
      await import("./openclaw-agent-db-lease-provenance.js");
    const provenance = readAgentDatabaseLeaseProvenance(pathname);
    expect(provenance).toMatch(/^process-v1:[a-f0-9]{64}$/);
    expect(readBoot).toHaveBeenCalledOnce();

    // Unavailable boot identity cannot lend a live peer's admission.
    readBoot.mockReturnValue({ ...bootResult, stdout: Buffer.from("unavailable") });
    vi.resetModules();
    const unknownBoot = await import("./openclaw-agent-db-lease-provenance.js");
    expect(unknownBoot.readAgentDatabaseLeaseProvenance(pathname)).toBeNull();
  },
);
