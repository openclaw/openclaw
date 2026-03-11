import { afterEach, describe, expect, it } from "vitest";
import { _resetProcessSupervisorForTest, getProcessSupervisor } from "./index.js";

afterEach(() => {
  _resetProcessSupervisorForTest();
});

describe("getProcessSupervisor singleton", () => {
  it("returns the same instance on repeated calls", () => {
    const a = getProcessSupervisor();
    const b = getProcessSupervisor();
    expect(a).toBe(b);
  });

  it("returns a fresh instance after _resetProcessSupervisorForTest", () => {
    const a = getProcessSupervisor();
    _resetProcessSupervisorForTest();
    const b = getProcessSupervisor();
    expect(a).not.toBe(b);
  });
});
