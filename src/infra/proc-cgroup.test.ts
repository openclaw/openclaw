import { describe, expect, it } from "vitest";
import { extractServiceCgroupFromCgroupContent } from "./proc-cgroup.js";

describe("extractServiceCgroupFromCgroupContent", () => {
  it("returns the service name for a cgroup v2 unified entry", () => {
    const content = "0::/system.slice/openclaw-host-gateway.service\n";
    expect(extractServiceCgroupFromCgroupContent(content)).toBe("openclaw-host-gateway.service");
  });

  it("returns the service name for a cgroup v1 controller entry", () => {
    const content =
      "12:pids:/system.slice/openclaw-node-host.service\n" +
      "11:memory:/system.slice/openclaw-node-host.service\n";
    expect(extractServiceCgroupFromCgroupContent(content)).toBe("openclaw-node-host.service");
  });

  it("handles nested scopes inside a service cgroup", () => {
    const content = "0::/system.slice/openclaw-host-gateway.service/child-0.scope\n";
    expect(extractServiceCgroupFromCgroupContent(content)).toBe("openclaw-host-gateway.service");
  });

  it("returns the innermost .service segment (user-session systemd services count)", () => {
    const content =
      "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-terminal.scope\n";
    // user@1000.service is a service segment; expect the leaf-most one.
    expect(extractServiceCgroupFromCgroupContent(content)).toBe("user@1000.service");
  });

  it("returns null when the cgroup is a pure slice/scope with no service", () => {
    const content = "0::/user.slice/user-1000.slice/session-1.scope\n";
    expect(extractServiceCgroupFromCgroupContent(content)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(extractServiceCgroupFromCgroupContent("")).toBeNull();
  });
});
