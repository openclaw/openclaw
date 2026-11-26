import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const { readBootAsync } = vi.hoisted(() => ({
  readBootAsync:
    vi.fn<
      (
        file: string,
        args: string[],
        options: { timeout: number },
        complete: (error: Error | null, stdout: string) => void,
      ) => void
    >(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: readBootAsync,
  spawnSync: vi.fn(),
}));

const dirs = createTempDirTracker();
afterEach(() => {
  readBootAsync.mockReset();
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

it.each(["success", "timeout"] as const)(
  "does not run a synchronous Windows boot lookup after asynchronous preparation (%s)",
  async (outcome) => {
    const pathname = path.join(dirs.make("agent-lease-provenance-"), "agent.sqlite");
    fs.writeFileSync(pathname, "synthetic database identity");
    mockProcessPlatform("win32");
    vi.resetModules();
    const { prepareAgentDatabaseLeaseProvenance, readAgentDatabaseLeaseProvenance } =
      await import("./openclaw-agent-db-lease-provenance.js");
    const pending = prepareAgentDatabaseLeaseProvenance();
    expect(pending).toBeDefined();
    expect(prepareAgentDatabaseLeaseProvenance()).toBe(pending);
    expect(readBootAsync).toHaveBeenCalledExactlyOnceWith(
      "powershell.exe",
      expect.arrayContaining([expect.stringContaining("LastBootUpTime")]),
      expect.objectContaining({ timeout: 5_000, windowsHide: true }),
      expect.any(Function),
    );
    expect(readAgentDatabaseLeaseProvenance(pathname)).toBeNull();
    const identity = "2026-09-01T00:00:00.0000000Z";
    const [call] = readBootAsync.mock.calls;
    if (!call) {
      throw new Error("Expected the Windows boot identity lookup to start");
    }
    const complete = call[3];
    complete(outcome === "timeout" ? new Error("ETIMEDOUT") : null, identity);
    await pending;
    const prepared = readAgentDatabaseLeaseProvenance(pathname);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(prepareAgentDatabaseLeaseProvenance()).toBeUndefined();
    if (outcome === "timeout") {
      expect(prepared).toBeNull();
    } else {
      vi.mocked(spawnSync).mockReturnValue({
        pid: 1,
        output: [],
        stdout: Buffer.from(identity),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
      });
      vi.resetModules();
      const synchronous = await import("./openclaw-agent-db-lease-provenance.js");
      expect(prepared).toMatch(/^process-v1:[a-f0-9]{64}$/);
      expect(prepared).toBe(synchronous.readAgentDatabaseLeaseProvenance(pathname));
    }
  },
);
