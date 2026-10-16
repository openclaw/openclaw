import type { Command } from "commander";
// Sub-CLI descriptor catalog used for root help placeholders and lazy registration.
import { isCronMachineOutput } from "../cron-cli/output-mode.js";
import { isDevicesMachineOutput } from "../devices-output-mode.js";
import { isGatewayMachineOutput } from "../gateway-cli/output-mode.js";
import { isModelsPlainMachineOutput, isModelsStatusJsonOutput } from "../models-output-mode.js";
import { isNodesMachineOutput } from "../nodes-cli/output-mode.js";
import { isProxyMachineOutput } from "../proxy-output-mode.js";
import { isSkillsMachineOutput } from "../skills-output-mode.js";
import { isSystemMachineOutput } from "../system-output-mode.js";
import type {
  NamedCommandDescriptor,
  RegisteredCommandDescriptor,
} from "./command-group-descriptors.js";
import { isPrivateQaCliEnabled, loadPrivateQaCliModule } from "./private-qa-cli.js";

export type SubCliRegistrationContext = {
  purpose?: "runtime" | "completion";
};

type SubCliCommand = RegisteredCommandDescriptor<
  [argv: string[], context: SubCliRegistrationContext]
>;
type SubCliRegistration = SubCliCommand["register"];

function command(
  name: string,
  description: string,
  register: SubCliRegistration,
  options: Partial<Omit<NamedCommandDescriptor, "name" | "description">> = {},
): SubCliCommand {
  return { name, description, hasSubcommands: true, ...options, register };
}

async function registerPluginCommandsIfNeeded(program: Command, argv: string[]) {
  const { resolveCliArgvInvocation } = await import("../argv-invocation.js");
  const { resolveCliCommandPathPolicy } = await import("../command-path-policy.js");
  const invocation = resolveCliArgvInvocation(argv);
  const shouldRegisterPluginCommands =
    !invocation.hasHelpOrVersion &&
    resolveCliCommandPathPolicy(invocation.commandPath).loadPlugins !== "never";
  if (shouldRegisterPluginCommands) {
    const { registerPluginCliCommandsFromValidatedConfig } = await import("../../plugins/cli.js");
    await registerPluginCliCommandsFromValidatedConfig(program);
  }
}

const registerCapability: SubCliRegistration = async (program, argv) =>
  (await import("../capability-cli.js")).registerCapabilityCli(program, argv);

const registerApprovals: SubCliRegistration = async (program) =>
  (await import("../exec-approvals-cli.js")).registerExecApprovalsCli(program);

const registerTui: SubCliRegistration = async (program) =>
  (await import("../tui-cli.js")).registerTuiCli(program);

const registerCron: SubCliRegistration = async (program) =>
  (await import("../cron-cli.js")).registerCronCli(program);

// One catalog owns placeholders, aliases, and lazy command registration.
const subCliCommands = [
  command("acp", "Run an ACP bridge backed by the Gateway", async (program) =>
    (await import("../acp-cli.js")).registerAcpCli(program),
  ),
  command(
    "gateway",
    "Run, inspect, and query the WebSocket Gateway",
    async (program) => (await import("../gateway-cli.js")).registerGatewayCli(program),
    { machineOutput: ({ argv }) => isGatewayMachineOutput(argv) },
  ),
  command("daemon", "Manage the Gateway service (launchd/systemd/schtasks)", async (program) =>
    (await import("../daemon-cli.js")).registerDaemonCli(program),
  ),
  command(
    "logs",
    "Tail gateway file logs via RPC",
    async (program) => (await import("../logs-cli.js")).registerLogsCli(program),
    { hasSubcommands: false },
  ),
  command(
    "system",
    "System tools (events, heartbeat, presence)",
    async (program) => (await import("../system-cli.js")).registerSystemCli(program),
    { machineOutput: ({ argv }) => isSystemMachineOutput(argv) },
  ),
  command(
    "models",
    "Model discovery, scanning, and configuration",
    async (program) => (await import("../models-cli.js")).registerModelsCli(program),
    {
      machineOutput: ({ argv }) =>
        isModelsStatusJsonOutput(argv) || isModelsPlainMachineOutput(argv),
    },
  ),
  command("promos", "Discover and claim promotional model offers from ClawHub", async (program) =>
    (await import("../promos-cli.js")).registerPromosCli(program),
  ),
  command(
    "telemetry",
    "Inspect and manage anonymous usage telemetry",
    async (program) => (await import("../telemetry-cli.js")).registerTelemetryCli(program),
    { parentDefaultHelp: true },
  ),
  command(
    "infer",
    "Run provider-backed inference commands through a stable CLI surface",
    registerCapability,
  ),
  command(
    "capability",
    "Run provider capability commands (fallback alias: infer)",
    registerCapability,
  ),
  command("approvals", "Manage approval policy and pending requests", registerApprovals, {
    parentDefaultHelp: true,
  }),
  command("exec-approvals", "Manage exec approvals (alias for approvals)", registerApprovals),
  command(
    "exec-policy",
    "Show or synchronize requested exec policy with host approvals",
    async (program) => (await import("../exec-policy-cli.js")).registerExecPolicyCli(program),
  ),
  command(
    "nodes",
    "Manage gateway-owned nodes (pairing, status, invoke, and media)",
    async (program, argv) => (await import("../nodes-cli.js")).registerNodesCli(program, argv),
    { machineOutput: ({ argv }) => isNodesMachineOutput(argv) },
  ),
  command(
    "devices",
    "Device pairing and auth tokens (for mobile app setup codes, use `openclaw qr` instead)",
    async (program) => (await import("../devices-cli.js")).registerDevicesCli(program),
    { machineOutput: ({ argv }) => isDevicesMachineOutput(argv), parentDefaultHelp: true },
  ),
  command(
    "users",
    "Manage durable user profiles and email aliases",
    async (program) => (await import("../users-cli.js")).registerUsersCli(program),
    { parentDefaultHelp: true },
  ),
  command("node", "Run and manage the headless node host service", async (program) =>
    (await import("../node-cli.js")).registerNodeCli(program),
  ),
  command(
    "connect",
    "Connect this machine to an OpenClaw Gateway as a node",
    async (program) => (await import("../connect-cli.js")).registerConnectCli(program),
    { hasSubcommands: false },
  ),
  command(
    "worker",
    "Run the restricted cloud worker runtime",
    async (program) => (await import("../worker-cli.js")).registerWorkerCli(program),
    { hasSubcommands: false },
  ),
  command("sandbox", "Manage sandbox containers (Docker-based agent isolation)", async (program) =>
    (await import("../sandbox-cli.js")).registerSandboxCli(program),
  ),
  command(
    "worktrees",
    "Create, inspect, restore, and clean up managed worktrees",
    async (program) => (await import("../worktrees-cli.js")).registerWorktreesCli(program),
    { parentDefaultHelp: true },
  ),
  command(
    "attach",
    "Attach Claude Code to a gateway session with scoped MCP tools",
    async (program) => (await import("../attach-cli.js")).registerAttachCli(program),
    { hasSubcommands: false },
  ),
  command("tui", "Open a terminal UI connected to the Gateway", registerTui, {
    hasSubcommands: false,
  }),
  command(
    "resume",
    "Resume a recent Gateway session in the TUI",
    async (program) => (await import("../resume-cli.js")).registerResumeCli(program),
    { hasSubcommands: false },
  ),
  command("terminal", "Open a local terminal UI (alias for tui --local)", registerTui, {
    hasSubcommands: false,
  }),
  command("chat", "Open a local terminal UI (alias for tui --local)", registerTui, {
    hasSubcommands: false,
  }),
  command("cron", "Manage automations (via Gateway)", registerCron, {
    machineOutput: ({ argv }) => isCronMachineOutput(argv),
    parentDefaultHelp: true,
  }),
  command("automations", "Manage automations (alias for cron)", registerCron, {
    machineOutput: ({ argv }) => isCronMachineOutput(argv),
    parentDefaultHelp: true,
  }),
  command("dns", "DNS helpers for wide-area discovery (Tailscale + CoreDNS)", async (program) =>
    (await import("../dns-cli.js")).registerDnsCli(program),
  ),
  command(
    "docs",
    "Search the live OpenClaw docs",
    async (program) => (await import("../docs-cli.js")).registerDocsCli(program),
    { hasSubcommands: false },
  ),
  command("qa", "Run QA scenarios and launch the private QA debugger UI", async (program) => {
    // This registrar comes from a source-checkout artifact, not a statically known module.
    const { registerQaLabCli } = await loadPrivateQaCliModule();
    if (typeof registerQaLabCli !== "function") {
      throw new Error("Missing program command registrar: registerQaLabCli");
    }
    await registerQaLabCli(program);
  }),
  command(
    "proxy",
    "Run the OpenClaw debug proxy and inspect captured traffic",
    async (program) => (await import("../proxy-cli.js")).registerProxyCli(program),
    { machineOutput: ({ argv }) => isProxyMachineOutput(argv) },
  ),
  command("hooks", "Manage internal agent hooks", async (program) =>
    (await import("../hooks-cli.js")).registerHooksCli(program),
  ),
  command("webhooks", "Webhook helpers and integrations", async (program) =>
    (await import("../webhooks-cli.js")).registerWebhooksCli(program),
  ),
  command(
    "qr",
    "Generate a mobile pairing QR code and setup code",
    async (program) => (await import("../qr-cli.js")).registerQrCli(program),
    { hasSubcommands: false },
  ),
  command("clawbot", "Legacy clawbot command aliases", async (program) =>
    (await import("../clawbot-cli.js")).registerClawbotCli(program),
  ),
  command("pairing", "Secure DM pairing (approve inbound requests)", async (program, argv) => {
    // Pairing reads channel capabilities while registering, so initialize plugins first.
    await registerPluginCommandsIfNeeded(program, argv);
    (await import("../pairing-cli.js")).registerPairingCli(program);
  }),
  command(
    "plugins",
    "Manage OpenClaw plugins and extensions",
    async (program, argv) => {
      (await import("../plugins-cli.js")).registerPluginsCli(program);
      await registerPluginCommandsIfNeeded(program, argv);
    },
    { parentDefaultHelp: true },
  ),
  command(
    "channels",
    "Manage connected chat channels and accounts",
    async (program, argv, context) =>
      (await import("../channels-cli.js")).registerChannelsCli(program, argv, {
        includeSetupOptions: context.purpose === "completion",
      }),
    { parentDefaultHelp: true },
  ),
  command(
    "directory",
    "Lookup contact and group IDs (self, peers, groups) for supported chat channels",
    async (program) => (await import("../directory-cli.js")).registerDirectoryCli(program),
  ),
  command(
    "security",
    "Audit local config and state for common security foot-guns",
    async (program) => (await import("../security-cli.js")).registerSecurityCli(program),
  ),
  command("secrets", "Secrets runtime controls", async (program) =>
    (await import("../secrets-cli.js")).registerSecretsCli(program),
  ),
  command(
    "skills",
    "List and inspect available skills",
    async (program) => (await import("../skills-cli.js")).registerSkillsCli(program),
    { machineOutput: ({ argv }) => isSkillsMachineOutput(argv) },
  ),
  command("update", "Update OpenClaw and inspect update channel status", async (program) =>
    (await import("../update-cli.js")).registerUpdateCli(program),
  ),
  command(
    "completion",
    "Generate shell completion script",
    async (program) => (await import("../completion-cli.js")).registerCompletionCli(program),
    { hasSubcommands: false },
  ),
] as const;

export const SUB_CLI_DESCRIPTORS = getSubCliEntriesCore();

export function getSubCliEntriesCore(): readonly SubCliCommand[] {
  return isPrivateQaCliEnabled()
    ? subCliCommands
    : subCliCommands.filter((descriptor) => descriptor.name !== "qa");
}

export function getSubCliCommandsWithSubcommands(): string[] {
  return getSubCliEntriesCore()
    .filter((descriptor) => descriptor.hasSubcommands)
    .map((descriptor) => descriptor.name);
}

export function getSubCliParentDefaultHelpCommands(): string[] {
  return getSubCliEntriesCore()
    .filter((descriptor) => descriptor.parentDefaultHelp)
    .map((descriptor) => descriptor.name);
}
