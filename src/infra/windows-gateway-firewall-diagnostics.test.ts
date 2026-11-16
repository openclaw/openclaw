import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { inspectWindowsGatewayFirewall } from "./windows-gateway-firewall-diagnostics.js";

type InspectOptions = Parameters<typeof inspectWindowsGatewayFirewall>[0];
type FirewallCommandRunner = typeof runCommandWithTimeout;

vi.mock("../process/exec.js", { spy: true });

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.mocked(runCommandWithTimeout).mockReset();
});
afterEach(() => vi.restoreAllMocks());

function inspect(
  runner: FirewallCommandRunner,
  options: Partial<Pick<InspectOptions, "bind">> = {},
) {
  vi.mocked(runCommandWithTimeout).mockImplementation(runner);
  return inspectWindowsGatewayFirewall({
    bind: "lan",
    port: 18789,
    ...options,
  });
}

function statePayload(active: Record<string, string> = {}, local = "True") {
  return {
    ConnectionProfiles: [{ NetworkCategory: "Public" }],
    ActiveFirewallProfiles: [
      {
        Name: "Public",
        Enabled: "True",
        DefaultInboundAction: "Block",
        AllowInboundRules: "True",
        AllowLocalFirewallRules: "True",
        ...active,
      },
    ],
    LocalFirewallProfiles: [
      {
        Name: "Public",
        Enabled: "True",
        DefaultInboundAction: "NotConfigured",
        AllowInboundRules: "NotConfigured",
        AllowLocalFirewallRules: local,
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
    State: params?.state ?? statePayload(),
    ActiveRules: params?.activeRules ?? [],
    LocalRules: params?.localRules ?? [ruleRow()],
  });
}

const baseRule = {
  DisplayName: "OpenClaw Gateway",
  Profile: "Any",
  PolicyStoreSource: "PersistentStore",
  PolicyStoreSourceType: "Local",
  Program: "Any",
  LocalAddress: "Any",
  RemoteAddress: "Any",
};
const ruleRow = (overrides: Partial<typeof baseRule> = {}) => ({ ...baseRule, ...overrides });

async function classify(params: Parameters<typeof quickPayloadJson>[0]) {
  const runner: FirewallCommandRunner = async () =>
    commandResult({ stdout: quickPayloadJson(params) });
  return await inspect(runner);
}

it("skips non-Windows and non-LAN bindings", async () => {
  const runner = vi.fn<FirewallCommandRunner>();
  await expect(inspect(runner, { bind: "loopback" })).resolves.toMatchObject({
    applies: false,
    code: "windows_firewall_not_applicable",
  });
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  await expect(inspect(runner)).resolves.toMatchObject({
    applies: false,
    code: "windows_firewall_not_applicable",
  });
  expect(runner).not.toHaveBeenCalled();
});

it("detects policy ignoring local rules", async () => {
  const diagnostic = await classify({
    state: statePayload({ AllowLocalFirewallRules: "False" }, "NotConfigured"),
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

it.each([
  ["inbound_rules_disabled", { state: statePayload({ AllowInboundRules: "False" }) }],
  [
    "program_scoped_rule_unverified",
    { localRules: [ruleRow({ Program: "C:\\Other\\server.exe" })] },
  ],
  ["address_scoped_rule_unverified", { localRules: [ruleRow({ RemoteAddress: "192.168.1.20" })] }],
  [
    "rule_profile_mismatch",
    {
      state: statePayload({ AllowLocalFirewallRules: "False" }, "NotConfigured"),
      activeRules: [
        ruleRow({
          DisplayName: "Managed private allow",
          Profile: "Private",
          PolicyStoreSource: "Intune",
          PolicyStoreSourceType: "MDM",
        }),
      ],
      localRules: [],
    },
  ],
] satisfies Array<[string, Parameters<typeof quickPayloadJson>[0]]>)(
  "classifies %s",
  async (code, payload) => {
    expect(await classify(payload)).toMatchObject({
      applies: true,
      severity: "warning",
      code: `windows_firewall_${code}`,
    });
  },
);

it("warns when no profiles or rules exist", async () => {
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

it("reports unrestricted profiles before checking rules", async () => {
  await expect(
    classify({
      state: statePayload({ DefaultInboundAction: "Allow" }, "NotConfigured"),
      localRules: [],
    }),
  ).resolves.toEqual({
    applies: true,
    severity: "info",
    code: "windows_firewall_unrestricted",
    message: "Windows Firewall is not blocking unsolicited inbound traffic on the active profile.",
    details: ["Active network profile: public."],
  });
});

it.each([
  [
    "a nonzero exit",
    async () => commandResult({ code: 1, stdout: quickPayloadJson() }),
    "OpenClaw could not quickly inspect Windows Firewall LAN Gateway policy.",
  ],
  [
    "truncated stderr",
    async () => commandResult({ stdout: quickPayloadJson(), stderrTruncatedBytes: 1 }),
    "OpenClaw could not quickly inspect Windows Firewall LAN Gateway policy.",
  ],
  [
    "malformed JSON",
    async () => commandResult({ stdout: "{" }),
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

it("avoids follow-up probes for disabled local rules", async () => {
  const runner = vi.fn<FirewallCommandRunner>(async () =>
    commandResult({
      stdout: quickPayloadJson({
        state: statePayload({ AllowLocalFirewallRules: "False" }, "NotConfigured"),
        activeRules: [],
        localRules: [],
      }),
    }),
  );
  await expect(inspect(runner)).resolves.toMatchObject({
    code: "windows_firewall_local_rules_ignored",
  });
  expect(runner).toHaveBeenCalledTimes(1);
});

it("retains managed ActiveStore rules", async () => {
  const runner = vi.fn<FirewallCommandRunner>(async (argv) => {
    const command = argv.join(" ");
    expect(command).toContain("requestedPolicyStoreSourceTypes");
    expect(command).toContain("-ieq");
    expect(command).toContain("GroupPolicy");
    expect(command).toContain("MDM");
    return commandResult({
      stdout: quickPayloadJson({
        state: statePayload({ AllowLocalFirewallRules: "False" }, "NotConfigured"),
        activeRules: [
          ruleRow({
            DisplayName: "MDM-managed Gateway allow",
            PolicyStoreSource: "Intune",
            PolicyStoreSourceType: "MDM",
          }),
        ],
        localRules: [ruleRow({ DisplayName: "Ignored local allow" })],
      }),
    });
  });
  await expect(inspect(runner)).resolves.toMatchObject({
    severity: "info",
    code: "windows_firewall_rule_present",
  });
  expect(runner).toHaveBeenCalledTimes(1);
});
