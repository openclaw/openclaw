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
import type { RegisteredCommandDescriptor } from "./command-group-descriptors.js";
import { loadPrivateQaCliModule } from "./private-qa-cli.js";
import { getSubCliCommandMetadata, type SubCliCommandName } from "./subcli-command-metadata.js";

export type SubCliRegistrationContext = {
  purpose?: "runtime" | "completion";
};

type SubCliCommand = RegisteredCommandDescriptor<
  [argv: string[], context: SubCliRegistrationContext]
>;
type SubCliRegistration = SubCliCommand["register"];

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

// Implementations are exhaustive over the metadata catalog; parsing never imports this map.
const registrations = {
  acp: { register: async (program) => (await import("../acp-cli.js")).registerAcpCli(program) },
  gateway: {
    register: async (program) => (await import("../gateway-cli.js")).registerGatewayCli(program),
    machineOutput: ({ argv }) => isGatewayMachineOutput(argv),
  },
  daemon: {
    register: async (program) => (await import("../daemon-cli.js")).registerDaemonCli(program),
  },
  logs: { register: async (program) => (await import("../logs-cli.js")).registerLogsCli(program) },
  system: {
    register: async (program) => (await import("../system-cli.js")).registerSystemCli(program),
    machineOutput: ({ argv }) => isSystemMachineOutput(argv),
  },
  models: {
    register: async (program) => (await import("../models-cli.js")).registerModelsCli(program),
    machineOutput: ({ argv }) => isModelsStatusJsonOutput(argv) || isModelsPlainMachineOutput(argv),
  },
  promos: {
    register: async (program) => (await import("../promos-cli.js")).registerPromosCli(program),
  },
  telemetry: {
    register: async (program) =>
      (await import("../telemetry-cli.js")).registerTelemetryCli(program),
  },
  infer: { register: registerCapability },
  capability: { register: registerCapability },
  approvals: { register: registerApprovals },
  "exec-approvals": { register: registerApprovals },
  "exec-policy": {
    register: async (program) =>
      (await import("../exec-policy-cli.js")).registerExecPolicyCli(program),
  },
  nodes: {
    register: async (program, argv) =>
      (await import("../nodes-cli.js")).registerNodesCli(program, argv),
    machineOutput: ({ argv }) => isNodesMachineOutput(argv),
  },
  devices: {
    register: async (program) => (await import("../devices-cli.js")).registerDevicesCli(program),
    machineOutput: ({ argv }) => isDevicesMachineOutput(argv),
  },
  users: {
    register: async (program) => (await import("../users-cli.js")).registerUsersCli(program),
  },
  node: { register: async (program) => (await import("../node-cli.js")).registerNodeCli(program) },
  connect: {
    register: async (program) => (await import("../connect-cli.js")).registerConnectCli(program),
  },
  worker: {
    register: async (program) => (await import("../worker-cli.js")).registerWorkerCli(program),
  },
  sandbox: {
    register: async (program) => (await import("../sandbox-cli.js")).registerSandboxCli(program),
  },
  worktrees: {
    register: async (program) =>
      (await import("../worktrees-cli.js")).registerWorktreesCli(program),
  },
  attach: {
    register: async (program) => (await import("../attach-cli.js")).registerAttachCli(program),
  },
  tui: { register: registerTui },
  resume: {
    register: async (program) => (await import("../resume-cli.js")).registerResumeCli(program),
  },
  terminal: { register: registerTui },
  chat: { register: registerTui },
  cron: { register: registerCron, machineOutput: ({ argv }) => isCronMachineOutput(argv) },
  automations: { register: registerCron, machineOutput: ({ argv }) => isCronMachineOutput(argv) },
  dns: { register: async (program) => (await import("../dns-cli.js")).registerDnsCli(program) },
  docs: { register: async (program) => (await import("../docs-cli.js")).registerDocsCli(program) },
  qa: {
    register: async (program) => {
      // This registrar comes from a source-checkout artifact, not a statically known module.
      const { registerQaLabCli } = await loadPrivateQaCliModule();
      if (typeof registerQaLabCli !== "function") {
        throw new Error("Missing program command registrar: registerQaLabCli");
      }
      await registerQaLabCli(program);
    },
  },
  proxy: {
    register: async (program) => (await import("../proxy-cli.js")).registerProxyCli(program),
    machineOutput: ({ argv }) => isProxyMachineOutput(argv),
  },
  hooks: {
    register: async (program) => (await import("../hooks-cli.js")).registerHooksCli(program),
  },
  webhooks: {
    register: async (program) => (await import("../webhooks-cli.js")).registerWebhooksCli(program),
  },
  qr: { register: async (program) => (await import("../qr-cli.js")).registerQrCli(program) },
  clawbot: {
    register: async (program) => (await import("../clawbot-cli.js")).registerClawbotCli(program),
  },
  pairing: {
    register: async (program, argv) => {
      // Pairing reads channel capabilities while registering, so initialize plugins first.
      await registerPluginCommandsIfNeeded(program, argv);
      (await import("../pairing-cli.js")).registerPairingCli(program);
    },
  },
  plugins: {
    register: async (program, argv) => {
      (await import("../plugins-cli.js")).registerPluginsCli(program);
      await registerPluginCommandsIfNeeded(program, argv);
    },
  },
  channels: {
    register: async (program, argv, context) =>
      (await import("../channels-cli.js")).registerChannelsCli(program, argv, {
        includeSetupOptions: context.purpose === "completion",
      }),
  },
  directory: {
    register: async (program) =>
      (await import("../directory-cli.js")).registerDirectoryCli(program),
  },
  security: {
    register: async (program) => (await import("../security-cli.js")).registerSecurityCli(program),
  },
  secrets: {
    register: async (program) => (await import("../secrets-cli.js")).registerSecretsCli(program),
  },
  skills: {
    register: async (program) => (await import("../skills-cli.js")).registerSkillsCli(program),
    machineOutput: ({ argv }) => isSkillsMachineOutput(argv),
  },
  update: {
    register: async (program) => (await import("../update-cli.js")).registerUpdateCli(program),
  },
  completion: {
    register: async (program) =>
      (await import("../completion-cli.js")).registerCompletionCli(program),
  },
} satisfies Record<SubCliCommandName, Pick<SubCliCommand, "register" | "machineOutput">>;

export function getSubCliEntriesCore(): readonly SubCliCommand[] {
  return getSubCliCommandMetadata().map((metadata) =>
    Object.assign({}, metadata, registrations[metadata.name]),
  );
}
