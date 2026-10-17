// Windows Gateway firewall diagnostics classify LAN reachability risks.
import { describe, expect, it, vi } from "vitest";
import { inspectWindowsGatewayFirewall } from "./windows-gateway-firewall-diagnostics.js";

type InspectOptions = Parameters<typeof inspectWindowsGatewayFirewall>[0];
type FirewallCommandRunner = NonNullable<InspectOptions["runCommandWithTimeout"]>;

function inspect(
  runner: FirewallCommandRunner,
  options: Partial<Pick<InspectOptions, "bind" | "platform" | "mode" | "timeoutMs">> = {},
) {
  return inspectWindowsGatewayFirewall({
    bind: "lan",
    port: 18789,
    platform: "win32",
    runCommandWithTimeout: runner,
    ...options,
  });
}

function statePayload(params?: {
  networkCategory?: string;
  defaultInboundAction?: string;
  allowInboundRules?: string;
  activeAllowLocalRules?: string;
  localAllowRules?: string;
}) {
  return {
    ConnectionProfiles: [
      {
        InterfaceAlias: "Ethernet",
        NetworkCategory: params?.networkCategory ?? "Public",
      },
    ],
    ActiveFirewallProfiles: [
      {
        Name: "Public",
        Enabled: "True",
        DefaultInboundAction: params?.defaultInboundAction ?? "Block",
        AllowInboundRules: params?.allowInboundRules ?? "True",
        AllowLocalFirewallRules: params?.activeAllowLocalRules ?? "True",
      },
    ],
    LocalFirewallProfiles: [
      {
        Name: "Public",
        Enabled: "True",
        DefaultInboundAction: "NotConfigured",
        AllowInboundRules: "NotConfigured",
        AllowLocalFirewallRules: params?.localAllowRules ?? "NotConfigured",
      },
    ],
  };
}

function quickPayloadJson(params?: {
  state?: ReturnType<typeof statePayload>;
  activeRules?: unknown[];
  localRules?: unknown[];
}) {
  return JSON.stringify({
    State: params?.state ?? statePayload({ localAllowRules: "True" }),
    ActiveRules: params?.activeRules ?? [],
    LocalRules: params?.localRules ?? [ruleRow()],
  });
}

function ruleRow(params?: {
  displayName?: string;
  profile?: string;
  policyStoreSource?: string;
  policyStoreSourceType?: string;
  program?: string;
  localAddress?: string;
  remoteAddress?: string;
}) {
  return {
    DisplayName: params?.displayName ?? "OpenClaw Gateway",
    Profile: params?.profile ?? "Any",
    PolicyStoreSource: params?.policyStoreSource ?? "PersistentStore",
    PolicyStoreSourceType: params?.policyStoreSourceType ?? "Local",
    Program: params?.program ?? "Any",
    LocalAddress: params?.localAddress ?? "Any",
    RemoteAddress: params?.remoteAddress ?? "Any",
  };
}

async function classify(params: Parameters<typeof quickPayloadJson>[0]) {
  const runner: FirewallCommandRunner = async () => ({
    code: 0,
    stdout: quickPayloadJson(params),
  });
  return await inspect(runner);
}
async function expectWarning(code: string, params: Parameters<typeof quickPayloadJson>[0]) {
  expect(await classify(params)).toMatchObject({
    applies: true,
    severity: "warning",
    code: `windows_firewall_${code}`,
  });
}

describe("Windows Gateway firewall diagnostics", () => {
  it("does not run commands outside Windows LAN binding", async () => {
    const runner = vi.fn<FirewallCommandRunner>();

    await expect(inspect(runner, { bind: "loopback" })).resolves.toMatchObject({
      applies: false,
      code: "windows_firewall_not_applicable",
    });
    await expect(inspect(runner, { platform: "darwin" })).resolves.toMatchObject({
      applies: false,
      code: "windows_firewall_not_applicable",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("detects managed Windows policy that ignores local Gateway allow rules", async () => {
    const diagnostic = await classify({
      state: statePayload({
        activeAllowLocalRules: "False",
        localAllowRules: "NotConfigured",
      }),
      localRules: [ruleRow()],
    });

    expect(diagnostic).toMatchObject({
      applies: true,
      severity: "warning",
      code: "windows_firewall_local_rules_ignored",
    });
    expect(diagnostic.details.join("\n")).toContain(
      "Local firewall rules are disabled for the active profile.",
    );
  });

  it("rejects allow rules when the active profile blocks inbound rules globally", async () => {
    await expectWarning("inbound_rules_disabled", {
      state: statePayload({ allowInboundRules: "False", localAllowRules: "True" }),
      localRules: [ruleRow()],
    });
  });

  it("does not treat program-scoped rules as sufficient Gateway allow rules", async () => {
    await expectWarning("program_scoped_rule_unverified", {
      state: statePayload({ localAllowRules: "True" }),
      localRules: [ruleRow({ program: "C:\\Other\\server.exe" })],
    });
  });

  it("does not treat address-scoped rules as sufficient Gateway allow rules", async () => {
    await expectWarning("address_scoped_rule_unverified", {
      state: statePayload({ localAllowRules: "True" }),
      localRules: [ruleRow({ remoteAddress: "192.168.1.20" })],
    });
  });

  it("prefers managed rule profile mismatch over local-rule-disabled fallback", async () => {
    await expectWarning("rule_profile_mismatch", {
      state: statePayload({ networkCategory: "Public", activeAllowLocalRules: "False" }),
      activeRules: [
        ruleRow({
          displayName: "Managed private allow",
          profile: "Private",
          policyStoreSource: "Intune",
          policyStoreSourceType: "MDM",
        }),
      ],
      localRules: [],
    });
  });

  it("reports no allow rule when the probe returns no active profiles", async () => {
    await expect(
      classify({
        state: {
          ConnectionProfiles: [],
          ActiveFirewallProfiles: [],
          LocalFirewallProfiles: [],
        },
        localRules: [],
      }),
    ).resolves.toEqual({
      applies: true,
      severity: "warning",
      code: "windows_firewall_no_allow_rule",
      message: "Windows Firewall is likely blocking LAN devices from reaching the Gateway port.",
      details: [
        "Active network profile: unknown.",
        "No enabled inbound TCP allow rule for the Gateway port was found in the active firewall policy.",
        "Allow the Gateway port in Windows Firewall, or use loopback, Tailscale, or an SSH tunnel instead of LAN binding.",
      ],
    });
  });

  it("reports an unblocked active profile before checking allow rules", async () => {
    await expect(
      classify({
        state: statePayload({ defaultInboundAction: "Allow" }),
        localRules: [],
      }),
    ).resolves.toEqual({
      applies: true,
      severity: "info",
      code: "windows_firewall_unrestricted",
      message:
        "Windows Firewall is not blocking unsolicited inbound traffic on the active profile.",
      details: ["Active network profile: public."],
    });
  });

  it.each([
    [
      "a nonzero exit",
      async () => ({ code: 1, stdout: quickPayloadJson() }),
      "OpenClaw could not quickly inspect Windows Firewall LAN Gateway policy.",
    ],
    [
      "truncated stderr",
      async () => ({ code: 0, stdout: quickPayloadJson(), stderrTruncatedBytes: 1 }),
      "OpenClaw could not quickly inspect Windows Firewall LAN Gateway policy.",
    ],
    [
      "malformed JSON",
      async () => ({ code: 0, stdout: "{" }),
      "OpenClaw could not parse Windows Firewall LAN Gateway policy.",
    ],
    [
      "a runner exception",
      async () => {
        throw new Error("probe failed");
      },
      "OpenClaw could not quickly inspect Windows Firewall LAN Gateway policy.",
    ],
  ] satisfies Array<[string, FirewallCommandRunner, string]>)(
    "fails closed after %s",
    async (_label, run, message) => {
      const runner = vi.fn<FirewallCommandRunner>(run);

      await expect(inspect(runner)).resolves.toEqual({
        applies: true,
        severity: "warning",
        code: "windows_firewall_inspection_failed",
        message,
        details: [
          "Run `openclaw gateway status --deep` again, or verify the advertised LAN URL from another device.",
        ],
      });
      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner.mock.calls[0]?.[1]).toEqual({
        timeoutMs: 5_000,
        maxOutputBytes: 2 * 1024 * 1024,
      });
    },
  );

  it("reports disabled local-rule policy without follow-up probes", async () => {
    const runner = vi.fn<FirewallCommandRunner>(async () => ({
      code: 0,
      stdout: quickPayloadJson({
        state: statePayload({ activeAllowLocalRules: "False" }),
        activeRules: [],
        localRules: [],
      }),
    }));

    await expect(inspect(runner)).resolves.toMatchObject({
      code: "windows_firewall_local_rules_ignored",
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("preserves managed ActiveStore allow rules by default", async () => {
    const runner = vi.fn<FirewallCommandRunner>(async (argv) => {
      const command = argv.join(" ");
      expect(command).toContain("requestedPolicyStoreSourceTypes");
      expect(command).toContain("-ieq");
      expect(command).toContain("GroupPolicy");
      expect(command).toContain("MDM");
      return {
        code: 0,
        stdout: quickPayloadJson({
          state: statePayload({ activeAllowLocalRules: "False" }),
          activeRules: [
            ruleRow({
              displayName: "MDM-managed Gateway allow",
              policyStoreSource: "Intune",
              policyStoreSourceType: "MDM",
            }),
          ],
          localRules: [ruleRow({ displayName: "Ignored local allow" })],
        }),
      };
    });

    await expect(inspect(runner)).resolves.toMatchObject({
      severity: "info",
      code: "windows_firewall_rule_present",
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("uses the quick probe by default and honors an explicit timeout", async () => {
    const createRunner = () =>
      vi.fn<FirewallCommandRunner>(async () => ({ code: 0, stdout: quickPayloadJson() }));
    const defaultRunner = createRunner();
    const explicitQuickRunner = createRunner();
    const overrideRunner = createRunner();

    const defaultResult = await inspect(defaultRunner);
    const explicitQuickResult = await inspect(explicitQuickRunner, {
      mode: "quick",
    });
    await inspect(overrideRunner, {
      timeoutMs: 1234,
    });

    expect(defaultResult).toEqual(explicitQuickResult);
    expect(defaultRunner).toHaveBeenCalledTimes(1);
    expect(explicitQuickRunner).toHaveBeenCalledTimes(1);
    expect(overrideRunner).toHaveBeenCalledTimes(1);
    expect(defaultRunner.mock.calls[0]?.[0]).toEqual(explicitQuickRunner.mock.calls[0]?.[0]);
    expect(defaultRunner.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 5_000 });
    expect(explicitQuickRunner.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 5_000 });
    expect(overrideRunner.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 1234 });
  });
});
