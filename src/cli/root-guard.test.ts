import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNotRoot } from "./root-guard.js";

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

  it("exits with code 1 when uid is 0 and no env override", () => {
    process.getuid = () => 0;
    assertNotRoot({});
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not exit when uid is 0 and OPENCLAW_ALLOW_ROOT=1", () => {
    process.getuid = () => 0;
    assertNotRoot({ OPENCLAW_ALLOW_ROOT: "1" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not exit when uid is 0 and OPENCLAW_CLI_CONTAINER_BYPASS=1 with container hint", () => {
    process.getuid = () => 0;
    assertNotRoot({ OPENCLAW_CLI_CONTAINER_BYPASS: "1", OPENCLAW_CONTAINER_HINT: "my-container" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits when uid is 0 and OPENCLAW_CLI_CONTAINER_BYPASS=1 without container hint", () => {
    process.getuid = () => 0;
    assertNotRoot({ OPENCLAW_CLI_CONTAINER_BYPASS: "1" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not exit when uid is non-zero", () => {
    process.getuid = () => 1000;
    assertNotRoot({});
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not exit when getuid is undefined (Windows)", () => {
    process.getuid = undefined as unknown as typeof process.getuid;
    assertNotRoot({});
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("error message mentions OPENCLAW_ALLOW_ROOT", () => {
    process.getuid = () => 0;
    assertNotRoot({});
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("OPENCLAW_ALLOW_ROOT");
  });

  it("error message mentions running as a non-root user", () => {
    process.getuid = () => 0;
    assertNotRoot({});
    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("non-root user");
  });
});
