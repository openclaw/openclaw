import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("assertNotRoot", () => {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  // Save and restore real getuid so we can replace it per test.
  const realGetuid = process.getuid;

  beforeEach(() => {
    exitSpy.mockClear();
    stderrSpy.mockClear();
    process.getuid = realGetuid;
  });

  afterAll(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    process.getuid = realGetuid;
  });

  // Use a fresh import each time to avoid module-level caching issues.
  async function loadAssertNotRoot() {
    const mod = await import("./root-guard.js");
    return mod.assertNotRoot;
  }

  it("exits with code 1 when uid is 0 and no env override", async () => {
    process.getuid = () => 0;
    const assertNotRoot = await loadAssertNotRoot();
    assertNotRoot({});
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not exit when uid is 0 and OPENCLAW_ALLOW_ROOT=1", async () => {
    process.getuid = () => 0;
    const assertNotRoot = await loadAssertNotRoot();
    assertNotRoot({ OPENCLAW_ALLOW_ROOT: "1" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not exit when uid is non-zero", async () => {
    process.getuid = () => 1000;
    const assertNotRoot = await loadAssertNotRoot();
    assertNotRoot({});
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not exit when getuid is undefined (Windows)", async () => {
    process.getuid = undefined as unknown as typeof process.getuid;
    const assertNotRoot = await loadAssertNotRoot();
    assertNotRoot({});
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("error message mentions OPENCLAW_ALLOW_ROOT", async () => {
    process.getuid = () => 0;
    const assertNotRoot = await loadAssertNotRoot();
    assertNotRoot({});
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("OPENCLAW_ALLOW_ROOT");
  });

  it("error message mentions running as a non-root user", async () => {
    process.getuid = () => 0;
    const assertNotRoot = await loadAssertNotRoot();
    assertNotRoot({});
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("non-root user");
  });
});
