import { describe, expect, it } from "vitest";
import { findGatewayPidsOnPortSync } from "./restart.js";

describe("findGatewayPidsOnPortSync", () => {
  it("returns an empty array for a port with no listeners", () => {
    const pids = findGatewayPidsOnPortSync(19999);
    expect(pids).toEqual([]);
  });

  it("never includes the current process PID", () => {
    const pids = findGatewayPidsOnPortSync(18789);
    expect(pids).not.toContain(process.pid);
  });

  it("returns an array (not undefined or null) on any port", () => {
    const pids = findGatewayPidsOnPortSync(0);
    expect(Array.isArray(pids)).toBe(true);
  });
});
