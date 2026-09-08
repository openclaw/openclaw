import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyTeammateProfile,
  isTeammateBackend,
  isTeammateInstall,
  TEAMMATE_SLA,
} from "./profile.js";

describe("teammate profile", () => {
  it("accepts docker, openshell, and firecracker backends", () => {
    expect(isTeammateBackend("docker")).toBe(true);
    expect(isTeammateBackend("openshell")).toBe(true);
    expect(isTeammateBackend("firecracker")).toBe(true);
    expect(isTeammateBackend("gateway")).toBe(false);
  });

  it("pins exec and sandbox onto a shared worker without enabling host exec", () => {
    const next = applyTeammateProfile({}, { backend: "docker", homeDir: "/var/lib/openclaw/bot" });
    expect(isTeammateInstall(next)).toBe(true);
    expect(next.tools?.exec?.host).toBe("sandbox");
    expect(next.tools?.elevated?.enabled).toBe(false);
    expect(next.agents?.defaults?.sandbox).toMatchObject({
      mode: "all",
      backend: "docker",
      scope: "shared",
      workspaceAccess: "rw",
      workspaceRoot: "/home/bot",
    });
    expect(next.agents?.defaults?.sandbox?.docker?.binds).toContain(
      "/var/lib/openclaw/bot:/home/bot:rw",
    );
    expect(next.agents?.defaults?.heartbeat?.every).toBe("30m");
    expect(TEAMMATE_SLA).toContain("worker disk is the computer");
  });

  it("does not rewrite an unrelated existing install until apply is called", () => {
    const existing: OpenClawConfig = {
      tools: { exec: { host: "gateway" } },
      agents: { defaults: { sandbox: { mode: "off" } } },
    };
    expect(isTeammateInstall(existing)).toBe(false);
    expect(existing.agents?.defaults?.sandbox?.mode).toBe("off");
  });

  it("gates firecracker behind an explicit backend and keeps docker as default", () => {
    const docker = applyTeammateProfile({}, { homeDir: "/tmp/bot" });
    expect(docker.agents?.defaults?.sandbox?.backend).toBe("docker");
    expect(docker.agents?.defaults?.sandbox?.docker?.runtime).toBeUndefined();

    const firecracker = applyTeammateProfile({}, { backend: "firecracker", homeDir: "/tmp/bot" });
    expect(firecracker.agents?.defaults?.sandbox?.backend).toBe("firecracker");
    expect(firecracker.agents?.defaults?.sandbox?.docker?.runtime).toBe("io.containerd.kata.v2");
  });
});
