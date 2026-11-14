import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SandboxDockerSettings } from "../config/types.sandbox.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  collectSandboxDangerousConfigFindings,
  collectSandboxDockerNoopFindings,
} from "./audit-extra.sync.js";

const image = { image: "ghcr.io/example/sandbox:latest" };
const finding = (suffix: string, extra = {}) =>
  expect.objectContaining({ checkId: `sandbox.${suffix}`, ...extra });
function sandboxConfig(docker: SandboxDockerSettings, mode: "all" | "off" = "all"): OpenClawConfig {
  return { agents: { defaults: { sandbox: { mode, docker } } } };
}
function collect(cfg: OpenClawConfig) {
  return [...collectSandboxDockerNoopFindings(cfg), ...collectSandboxDangerousConfigFindings(cfg)];
}

describe("security audit sandbox docker config", () => {
  afterEach(() => vi.restoreAllMocks());

  it("evaluates sandbox docker config findings", async () => {
    const isolatedHome = path.join(os.tmpdir(), "openclaw-security-audit-home");
    vi.spyOn(os, "homedir").mockReturnValue(isolatedHome);
    await withEnvAsync({ HOME: isolatedHome, USERPROFILE: isolatedHome }, async () => {
      expect(collect(sandboxConfig(image, "off"))).toContainEqual(
        finding("docker_config_mode_off"),
      );
      const enabled = sandboxConfig(image, "off");
      enabled.agents = { ...enabled.agents, entries: { ops: { sandbox: { mode: "all" } } } };
      expect(collect(enabled)).not.toContainEqual(finding("docker_config_mode_off"));

      const cases: Array<[SandboxDockerSettings, string[]]> = [
        [
          {
            binds: ["/etc/passwd:/mnt/passwd:ro", "/run:/run"],
            network: "host",
            seccompProfile: "unconfined",
            apparmorProfile: "unconfined",
          },
          ["bind_mount", "network_mode", "seccomp_profile", "apparmor_profile"],
        ],
        [
          { binds: [path.join(isolatedHome, ".docker", "config.json") + ":/mnt/docker:ro"] },
          ["bind_mount"],
        ],
        [{ network: "container:peer" }, ["network_mode"]],
      ];
      for (const [docker, suffixes] of cases) {
        const findings = collect(sandboxConfig(docker));
        for (const suffix of suffixes) {
          expect(findings).toContainEqual(finding(`dangerous_${suffix}`, { severity: "critical" }));
        }
      }
      expect(
        collect(sandboxConfig({ binds: ["D:/data/openclaw/src:/src:ro"] })),
      ).not.toContainEqual(finding("bind_mount_non_absolute"));
    });
  });

  it("reports canonical agent paths for docker sandbox findings", () => {
    const config: OpenClawConfig = {
      agents: {
        entries: {
          ops: {
            sandbox: { mode: "off", docker: { ...image, binds: ["/etc/passwd:/mnt/passwd:ro"] } },
          },
        },
      },
    };
    const findings = collect(config);
    for (const [suffix, field] of [
      ["docker_config_mode_off", ""],
      ["dangerous_bind_mount", ".binds"],
    ] as const) {
      expect(findings).toContainEqual(
        finding(suffix, {
          detail: expect.stringContaining(`agents.entries.ops.sandbox.docker${field}`),
        }),
      );
    }
  });
});
