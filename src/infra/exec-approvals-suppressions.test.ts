import { describe, expect, it, vi } from "vitest";
import { evaluateShellAllowlistWithAuthorization } from "./exec-approvals-allowlist.js";
import { commandRequiresSecurityAuditSuppressionApproval } from "./exec-approvals-policy.js";

async function inspect(
  command: string,
  env: NodeJS.ProcessEnv = { RIPGREP_CONFIG_PATH: "" },
  platform: NodeJS.Platform = "linux",
) {
  const analysis = await evaluateShellAllowlistWithAuthorization({
    command,
    env,
    allowlist: [],
    safeBins: new Set(),
    platform,
  });
  return { command, env, ...analysis };
}

describe("suppression inspection preflight", () => {
  it.each([
    ["rg -nF --glob '*.ts' security.audit.suppressions src | head -n 10", false],
    ["grep -Rn security.audit.suppressions src", false],
    ["cat docs/security.audit.suppressions.md", false],
    ["sed -n '1,120p' docs/security.audit.suppressions.md", false],
    ["openclaw config get security.audit.suppressions", false],
    ["openclaw config set security.audit.suppressions '[]'", true],
    ["rg security.audit.suppressions src; touch output", true],
    ["cat security.audit.suppressions.json | tee openclaw.json", true],
    ["rg security.audit.suppressions src > openclaw.json", true],
    ["sed -n '1p' -f security.audit.suppressions", true],
    ["sed -i 's/security.audit.suppressions/replacement/' openclaw.json", true],
    ["rg --pre=./writer security.audit.suppressions src", true],
    ["rg --hostname-bin ./writer security.audit.suppressions src", true],
    ["rg -nz security.audit.suppressions src", true],
    ["rg --unknown security.audit.suppressions src", true],
    ["constructor security.audit.suppressions", true],
    ["rg security.audit.suppressions *", true],
    ["rg security.audit.suppressions $(touch output)", true],
    ["sh -lc 'rg security.audit.suppressions src'", true],
    [
      "openclaw config get security.audit.suppressions; cat > openclaw.json <<'EOF'\n{security:{audit:{suppressions:[]}}}\nEOF",
      true,
    ],
  ])("classifies the complete command %s", async (command, expected) => {
    // Preflight checks syntax; executable identity is enforced on the execution host.
    expect(
      commandRequiresSecurityAuditSuppressionApproval({
        ...(await inspect(command)),
        deferReaderTrustToNode: true,
      }),
    ).toBe(expected);
  });

  it.each([
    ["openclaw config validate security.audit.suppressions", false],
    ["openclaw config unset security.audit.suppressions", true],
    ["rg security.audit.suppressions src", true],
    ["openclaw config get $(security.audit.suppressions)", true],
    [
      'powershell -File writer.ps1 -Command "openclaw config get security.audit.suppressions"',
      true,
    ],
  ] as const)("preserves Windows config-read analysis: %s", async (command, expected) => {
    const input = await inspect(command, {}, "win32");
    expect(input.authorizationPlan).toBeUndefined();
    expect(commandRequiresSecurityAuditSuppressionApproval(input)).toBe(expected);
  });

  it("does not use incomplete or stale analysis as the config-read exception", async () => {
    const input = await inspect("openclaw config get security.audit.suppressions", {}, "win32");
    for (const incomplete of [
      { ...input, analysisOk: false },
      { ...input, segments: [] },
      { ...input, command: input.command + "; whoami" },
      {
        ...input,
        transportExecutable: {
          kind: "executable" as const,
          rawExecutable: "./powershell",
          executableName: "powershell",
        },
      },
    ]) {
      expect(commandRequiresSecurityAuditSuppressionApproval(incomplete)).toBe(true);
    }
  });

  it.each(["linux", "win32"] as const)(
    "honors ripgrep environment and flag semantics on %s",
    async (platform) => {
      const plan = await inspect("rg security.audit.suppressions src");
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      vi.stubEnv("RIPGREP_CONFIG_PATH", "");
      try {
        expect(
          commandRequiresSecurityAuditSuppressionApproval({
            ...plan,
            env: { Ripgrep_Config_Path: "config" },
            deferReaderTrustToNode: true,
          }),
        ).toBe(platform === "win32");
        for (const [flags, expected] of [
          ["--no-config", false],
          ["-e --no-config", true],
          ["--", true],
        ] as const) {
          expect(
            commandRequiresSecurityAuditSuppressionApproval({
              ...(await inspect("rg " + flags + " security.audit.suppressions src", {
                RIPGREP_CONFIG_PATH: "config",
              })),
              deferReaderTrustToNode: true,
            }),
          ).toBe(expected);
        }
      } finally {
        platformSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("does not trust missing plans, stale plans, or unresolved reader identity", async () => {
    const input = await inspect("./rg security.audit.suppressions src");
    expect(commandRequiresSecurityAuditSuppressionApproval(input)).toBe(true);
    expect(
      commandRequiresSecurityAuditSuppressionApproval({
        ...input,
        authorizationPlan: undefined,
        deferReaderTrustToNode: true,
      }),
    ).toBe(true);
    expect(
      commandRequiresSecurityAuditSuppressionApproval({
        ...input,
        command: input.command + "; touch output",
        deferReaderTrustToNode: true,
      }),
    ).toBe(true);
  });
});
