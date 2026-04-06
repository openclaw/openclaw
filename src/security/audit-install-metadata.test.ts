import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runSecurityAudit } from "./audit.js";

const execDockerRawUnavailable = async () => ({
  stdout: Buffer.alloc(0),
  stderr: Buffer.from("docker unavailable"),
  code: 1,
});

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
    return runSecurityAudit({
      config: cfg,
      includeFilesystem: true,
      includeChannelSecurity: false,
      stateDir,
      configPath: path.join(stateDir, "openclaw.json"),
      execDockerRawFn: execDockerRawUnavailable,
    });
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
      const res = await testCase.run();
      for (const checkId of testCase.expectedPresent ?? []) {
        expect(
          res.findings.some(
            (finding) => finding.checkId === checkId && finding.severity === "warn",
          ),
          testCase.name,
        ).toBe(true);
      }
      for (const checkId of testCase.expectedAbsent ?? []) {
        expect(
          res.findings.some((finding) => finding.checkId === checkId),
          testCase.name,
        ).toBe(false);
      }
    }
  });
});
