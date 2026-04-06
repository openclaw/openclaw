import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createPathResolutionEnv, withEnvAsync } from "../test-utils/env.js";
import { runSecurityAudit } from "./audit.js";

const execDockerRawUnavailable = async () => ({
  stdout: Buffer.alloc(0),
  stderr: Buffer.from("docker unavailable"),
  code: 1,
});

describe("security audit extension tool reachability findings", () => {
  let fixtureRoot = "";
  let sharedExtensionsStateDir = "";
  let isolatedHome = "";
  let homedirSpy: { mockRestore(): void } | undefined;
  const pathResolutionEnvKeys = [
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
  ] as const;
  const previousPathResolutionEnv: Partial<Record<(typeof pathResolutionEnvKeys)[number], string>> =
    {};

  const runSharedExtensionsAudit = async (config: OpenClawConfig) => {
    return runSecurityAudit({
      config,
      includeFilesystem: true,
      includeChannelSecurity: false,
      stateDir: sharedExtensionsStateDir,
      configPath: path.join(sharedExtensionsStateDir, "openclaw.json"),
      execDockerRawFn: execDockerRawUnavailable,
    });
  };

  beforeAll(async () => {
    const osModule = await import("node:os");
    const vitestModule = await import("vitest");
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-extensions-"));
    isolatedHome = path.join(fixtureRoot, "home");
    const isolatedEnv = createPathResolutionEnv(isolatedHome, { OPENCLAW_HOME: isolatedHome });
    for (const key of pathResolutionEnvKeys) {
      previousPathResolutionEnv[key] = process.env[key];
      const value = isolatedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    homedirSpy = vitestModule.vi
      .spyOn(osModule.default ?? osModule, "homedir")
      .mockReturnValue(isolatedHome);
    await fs.mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    sharedExtensionsStateDir = path.join(fixtureRoot, "shared-extensions-state");
    await fs.mkdir(path.join(sharedExtensionsStateDir, "extensions", "some-plugin"), {
      recursive: true,
      mode: 0o700,
    });
  });

  afterAll(async () => {
    homedirSpy?.mockRestore();
    for (const key of pathResolutionEnvKeys) {
      const value = previousPathResolutionEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("evaluates extension tool reachability findings", async () => {
    const cases = [
      {
        name: "flags extensions without plugins.allow",
        cfg: {} satisfies OpenClawConfig,
        assert: (res: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            res.findings.some(
              (finding) =>
                finding.checkId === "plugins.extensions_no_allowlist" &&
                finding.severity === "warn",
            ),
          ).toBe(true);
        },
      },
      {
        name: "flags enabled extensions when tool policy can expose plugin tools",
        cfg: {
          plugins: { allow: ["some-plugin"] },
        } satisfies OpenClawConfig,
        assert: (res: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            res.findings.some(
              (finding) =>
                finding.checkId === "plugins.tools_reachable_permissive_policy" &&
                finding.severity === "warn",
            ),
          ).toBe(true);
        },
      },
      {
        name: "does not flag plugin tool reachability when profile is restrictive",
        cfg: {
          plugins: { allow: ["some-plugin"] },
          tools: { profile: "coding" },
        } satisfies OpenClawConfig,
        assert: (res: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            res.findings.some(
              (finding) => finding.checkId === "plugins.tools_reachable_permissive_policy",
            ),
          ).toBe(false);
        },
      },
      {
        name: "flags unallowlisted extensions as warn-level findings when extension inventory exists",
        cfg: {
          channels: {
            discord: { enabled: true, token: "t" },
          },
        } satisfies OpenClawConfig,
        assert: (res: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            res.findings.some(
              (finding) =>
                finding.checkId === "plugins.extensions_no_allowlist" &&
                finding.severity === "warn",
            ),
          ).toBe(true);
        },
      },
      {
        name: "treats SecretRef channel credentials as configured for extension allowlist severity",
        cfg: {
          channels: {
            discord: {
              enabled: true,
              token: {
                source: "env",
                provider: "default",
                id: "DISCORD_BOT_TOKEN",
              } as unknown as string,
            },
          },
        } satisfies OpenClawConfig,
        assert: (res: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            res.findings.some(
              (finding) =>
                finding.checkId === "plugins.extensions_no_allowlist" &&
                finding.severity === "warn",
            ),
          ).toBe(true);
        },
      },
    ] as const;

    await withEnvAsync(
      {
        DISCORD_BOT_TOKEN: undefined,
        TELEGRAM_BOT_TOKEN: undefined,
        SLACK_BOT_TOKEN: undefined,
        SLACK_APP_TOKEN: undefined,
      },
      async () => {
        for (const testCase of cases) {
          testCase.assert(await runSharedExtensionsAudit(testCase.cfg));
        }
      },
    );
  });
});
