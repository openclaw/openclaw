import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createPathResolutionEnv, withEnvAsync } from "../test-utils/env.js";
import { collectPluginsTrustFindings } from "./audit-extra.async.js";

describe("security audit install metadata findings", () => {
  let fixtureRoot = "";
  let sharedInstallMetadataStateDir = "";
  let caseId = 0;

  const makeTmpDir = async (label: string) => {
    const dir = path.join(fixtureRoot, `case-${caseId++}-${label}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  const runInstallMetadataAudit = async (cfg: OpenClawConfig, stateDir: string) => {
    return await collectPluginsTrustFindings({ cfg, stateDir });
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-install-"));
    sharedInstallMetadataStateDir = path.join(fixtureRoot, "shared-install-metadata-state");
    await fs.mkdir(sharedInstallMetadataStateDir, { recursive: true });
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("evaluates install metadata findings", async () => {
    const cases: Array<{
      name: string;
      run: () => Promise<Awaited<ReturnType<typeof runInstallMetadataAudit>>>;
      expectedPresent?: readonly string[];
      expectedAbsent?: readonly string[];
    }> = [
      {
        name: "warns on unpinned npm install specs and missing integrity metadata",
        run: async () =>
          runInstallMetadataAudit(
            {
              plugins: {
                installs: {
                  "voice-call": {
                    source: "npm",
                    spec: "@openclaw/voice-call",
                  },
                },
              },
              hooks: {
                internal: {
                  installs: {
                    "test-hooks": {
                      source: "npm",
                      spec: "@openclaw/test-hooks",
                    },
                  },
                },
              },
            },
            sharedInstallMetadataStateDir,
          ),
        expectedPresent: [
          "plugins.installs_unpinned_npm_specs",
          "plugins.installs_missing_integrity",
          "hooks.installs_unpinned_npm_specs",
          "hooks.installs_missing_integrity",
        ],
      },
      {
        name: "does not warn on pinned npm install specs with integrity metadata",
        run: async () =>
          runInstallMetadataAudit(
            {
              plugins: {
                installs: {
                  "voice-call": {
                    source: "npm",
                    spec: "@openclaw/voice-call@1.2.3",
                    integrity: "sha512-plugin",
                  },
                },
              },
              hooks: {
                internal: {
                  installs: {
                    "test-hooks": {
                      source: "npm",
                      spec: "@openclaw/test-hooks@1.2.3",
                      integrity: "sha512-hook",
                    },
                  },
                },
              },
            },
            sharedInstallMetadataStateDir,
          ),
        expectedAbsent: [
          "plugins.installs_unpinned_npm_specs",
          "plugins.installs_missing_integrity",
          "hooks.installs_unpinned_npm_specs",
          "hooks.installs_missing_integrity",
        ],
      },
      {
        name: "warns when install records drift from installed package versions",
        run: async () => {
          const tmp = await makeTmpDir("install-version-drift");
          const stateDir = path.join(tmp, "state");
          const pluginDir = path.join(stateDir, "extensions", "voice-call");
          const hookDir = path.join(stateDir, "hooks", "test-hooks");
          await fs.mkdir(pluginDir, { recursive: true });
          await fs.mkdir(hookDir, { recursive: true });
          await fs.writeFile(
            path.join(pluginDir, "package.json"),
            JSON.stringify({ name: "@openclaw/voice-call", version: "9.9.9" }),
            "utf-8",
          );
          await fs.writeFile(
            path.join(hookDir, "package.json"),
            JSON.stringify({ name: "@openclaw/test-hooks", version: "8.8.8" }),
            "utf-8",
          );

          return runInstallMetadataAudit(
            {
              plugins: {
                installs: {
                  "voice-call": {
                    source: "npm",
                    spec: "@openclaw/voice-call@1.2.3",
                    integrity: "sha512-plugin",
                    resolvedVersion: "1.2.3",
                  },
                },
              },
              hooks: {
                internal: {
                  installs: {
                    "test-hooks": {
                      source: "npm",
                      spec: "@openclaw/test-hooks@1.2.3",
                      integrity: "sha512-hook",
                      resolvedVersion: "1.2.3",
                    },
                  },
                },
              },
            },
            stateDir,
          );
        },
        expectedPresent: ["plugins.installs_version_drift", "hooks.installs_version_drift"],
      },
    ];

    for (const testCase of cases) {
      const findings = await testCase.run();
      for (const checkId of testCase.expectedPresent ?? []) {
        expect(
          findings.some((finding) => finding.checkId === checkId && finding.severity === "warn"),
          testCase.name,
        ).toBe(true);
      }
      for (const checkId of testCase.expectedAbsent ?? []) {
        expect(
          findings.some((finding) => finding.checkId === checkId),
          testCase.name,
        ).toBe(false);
      }
    }
  });
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
    return await collectPluginsTrustFindings({
      cfg: config,
      stateDir: sharedExtensionsStateDir,
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
        assert: (findings: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            findings.some(
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
        assert: (findings: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            findings.some(
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
        assert: (findings: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            findings.some(
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
        assert: (findings: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            findings.some(
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
        assert: (findings: Awaited<ReturnType<typeof runSharedExtensionsAudit>>) => {
          expect(
            findings.some(
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
