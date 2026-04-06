import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SecurityAuditReport } from "./audit.js";
import { audit } from "./audit.test-helpers.js";

function expectFindingSet(params: {
  res: SecurityAuditReport;
  name: string;
  expectedPresent?: readonly string[];
  expectedAbsent?: readonly string[];
  severity?: string;
}) {
  const severity = params.severity ?? "warn";
  for (const checkId of params.expectedPresent ?? []) {
    expect(
      params.res.findings.some(
        (finding) => finding.checkId === checkId && finding.severity === severity,
      ),
      `${params.name}:${checkId}`,
    ).toBe(true);
  }
  for (const checkId of params.expectedAbsent ?? []) {
    expect(
      params.res.findings.some((finding) => finding.checkId === checkId),
      `${params.name}:${checkId}`,
    ).toBe(false);
  }
}

describe("security audit sandbox docker config", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("evaluates sandbox docker config findings", async () => {
    const isolatedHome = path.join(os.tmpdir(), "openclaw-security-audit-home");
    vi.spyOn(os, "homedir").mockReturnValue(isolatedHome);

    const cases = [
      {
        name: "mode off with docker config only",
        cfg: {
          agents: {
            defaults: {
              sandbox: {
                mode: "off",
                docker: { image: "ghcr.io/example/sandbox:latest" },
              },
            },
          },
        } as OpenClawConfig,
        expectedFindings: [{ checkId: "sandbox.docker_config_mode_off" }],
      },
      {
        name: "agent enables sandbox mode",
        cfg: {
          agents: {
            defaults: {
              sandbox: {
                mode: "off",
                docker: { image: "ghcr.io/example/sandbox:latest" },
              },
            },
            list: [{ id: "ops", sandbox: { mode: "all" } }],
          },
        } as OpenClawConfig,
        expectedFindings: [],
        expectedAbsent: ["sandbox.docker_config_mode_off"],
      },
      {
        name: "dangerous binds, host network, seccomp, and apparmor",
        cfg: {
          agents: {
            defaults: {
              sandbox: {
                mode: "all",
                docker: {
                  binds: ["/etc/passwd:/mnt/passwd:ro", "/run:/run"],
                  network: "host",
                  seccompProfile: "unconfined",
                  apparmorProfile: "unconfined",
                },
              },
            },
          },
        } as OpenClawConfig,
        expectedFindings: [
          { checkId: "sandbox.dangerous_bind_mount", severity: "critical" },
          { checkId: "sandbox.dangerous_network_mode", severity: "critical" },
          { checkId: "sandbox.dangerous_seccomp_profile", severity: "critical" },
          { checkId: "sandbox.dangerous_apparmor_profile", severity: "critical" },
        ],
      },
      {
        name: "home credential bind is treated as dangerous",
        cfg: {
          agents: {
            defaults: {
              sandbox: {
                mode: "all",
                docker: {
                  binds: [path.join(isolatedHome, ".docker", "config.json") + ":/mnt/docker:ro"],
                },
              },
            },
          },
        } as OpenClawConfig,
        expectedFindings: [
          {
            checkId: "sandbox.dangerous_bind_mount",
            severity: "critical",
            title: "Dangerous bind mount in sandbox config",
          },
        ],
      },
      {
        name: "container namespace join network mode",
        cfg: {
          agents: {
            defaults: {
              sandbox: {
                mode: "all",
                docker: {
                  network: "container:peer",
                },
              },
            },
          },
        } as OpenClawConfig,
        expectedFindings: [
          {
            checkId: "sandbox.dangerous_network_mode",
            severity: "critical",
            title: "Dangerous network mode in sandbox config",
          },
        ],
      },
    ] as const;

    await Promise.all(
      cases.map(async (testCase) => {
        const res = await audit(testCase.cfg);
        if (testCase.expectedFindings.length > 0) {
          expect(res.findings, testCase.name).toEqual(
            expect.arrayContaining(
              testCase.expectedFindings.map((finding) => expect.objectContaining(finding)),
            ),
          );
        }
        expectFindingSet({
          res,
          name: testCase.name,
          expectedAbsent: "expectedAbsent" in testCase ? testCase.expectedAbsent : [],
        });
      }),
    );
  });
});
