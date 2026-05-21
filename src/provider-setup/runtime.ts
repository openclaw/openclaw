import { randomUUID } from "node:crypto";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { resolveChannelConfigWrites } from "../channels/plugins/config-writes.js";
import { updateConfig } from "../commands/models/shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import {
  applyDefaultModel,
  pickAuthMethod,
  restoreConfiguredPrimaryModel,
} from "../plugins/provider-auth-choice-helpers.js";
import { runProviderPluginAuthMethod } from "../plugins/provider-auth-choice.js";
import { runProviderModelSelectedHook } from "../plugins/provider-wizard.js";
import { resolvePluginProviders } from "../plugins/providers.runtime.js";
import { resolvePluginSetupRegistry } from "../plugins/setup-registry.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../plugins/types.js";
import { defaultRuntime } from "../runtime.js";
import { WizardCancelledError, type WizardPrompter } from "../wizard/prompts.js";
import { WizardSession, type WizardStep } from "../wizard/session.js";

type ProviderSetupBinding = {
  channel: string;
  accountId?: string;
  conversationId: string;
  senderId?: string;
};

type ProviderSetupSessionRecord = {
  session: WizardSession;
  binding: ProviderSetupBinding;
  callbackIds: Set<string>;
  expiresAt: number;
  lastStep?: WizardStep;
};

type ProviderSetupCallback =
  | { type: "answer"; sessionId: string; value: unknown }
  | { type: "cancel"; sessionId: string }
  | { type: "dashboard" }
  | { type: "start" };

type StoredProviderSetupCallback = {
  callback: ProviderSetupCallback;
  expiresAt: number;
};

export type ProviderSetupCommandParams = {
  cfg: OpenClawConfig;
  commandBody: string;
  channel: string;
  accountId?: string;
  conversationId?: string;
  senderId?: string;
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  isGroup: boolean;
  agentId?: string;
  workspaceDir: string;
};

export type ProviderSetupTextInputResult = {
  handled: boolean;
  reply?: ReplyPayload;
  deleteInputMessage?: boolean;
};

const PROVIDER_SETUP_COMMAND = "/providers";
const PROVIDER_SETUP_INTERACTION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map<string, ProviderSetupSessionRecord>();
const callbacks = new Map<string, StoredProviderSetupCallback>();

function normalizeCommandTail(commandBody: string): string {
  const trimmed = commandBody.trim();
  if (trimmed === PROVIDER_SETUP_COMMAND) {
    return "";
  }
  return trimmed.startsWith(`${PROVIDER_SETUP_COMMAND} `)
    ? trimmed.slice(PROVIDER_SETUP_COMMAND.length + 1).trim()
    : "";
}

function buildCommandButton(label: string, command: string) {
  return { text: label, callback_data: command };
}

function buildUrlButton(label: string, url: string) {
  return { text: label, url };
}

function storeCallback(
  record: ProviderSetupSessionRecord,
  callback: ProviderSetupCallback,
): string {
  const id = randomUUID().replaceAll("-", "").slice(0, 16);
  callbacks.set(id, { callback, expiresAt: record.expiresAt });
  record.callbackIds.add(id);
  return `${PROVIDER_SETUP_COMMAND} c ${id}`;
}

function storeLooseCallback(callback: ProviderSetupCallback): string {
  pruneExpiredProviderSetupState(Date.now());
  const id = randomUUID().replaceAll("-", "").slice(0, 16);
  callbacks.set(id, { callback, expiresAt: Date.now() + PROVIDER_SETUP_INTERACTION_TTL_MS });
  return `${PROVIDER_SETUP_COMMAND} c ${id}`;
}

function clearSessionCallbacks(record: ProviderSetupSessionRecord) {
  for (const id of record.callbackIds) {
    callbacks.delete(id);
  }
  record.callbackIds.clear();
}

function expireSession(sessionId: string, record: ProviderSetupSessionRecord) {
  record.session.cancel();
  sessions.delete(sessionId);
  clearSessionCallbacks(record);
}

function pruneExpiredProviderSetupState(now: number) {
  for (const [id, stored] of callbacks) {
    if (stored.expiresAt <= now) {
      callbacks.delete(id);
    }
  }
  for (const [sessionId, record] of sessions) {
    if (record.expiresAt <= now) {
      expireSession(sessionId, record);
    }
  }
}

function refreshSessionExpiry(record: ProviderSetupSessionRecord) {
  record.expiresAt = Date.now() + PROVIDER_SETUP_INTERACTION_TTL_MS;
}

function buildSessionButton(
  record: ProviderSetupSessionRecord,
  label: string,
  callback: ProviderSetupCallback,
) {
  return buildCommandButton(label, storeCallback(record, callback));
}

function providerSetupChannelData(
  buttons: Array<Array<{ text: string; callback_data?: string; url?: string }>>,
): ReplyPayload["channelData"] {
  return { telegram: { buttons } };
}

function sameBinding(left: ProviderSetupBinding, right: ProviderSetupBinding): boolean {
  return (
    left.channel === right.channel &&
    left.accountId === right.accountId &&
    left.conversationId === right.conversationId &&
    left.senderId === right.senderId
  );
}

function resolveBinding(params: ProviderSetupCommandParams): ProviderSetupBinding | null {
  if (!params.conversationId) {
    return null;
  }
  return {
    channel: params.channel,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    conversationId: params.conversationId,
    ...(params.senderId ? { senderId: params.senderId } : {}),
  };
}

function listSetupProviders(params: {
  config: OpenClawConfig;
  workspaceDir: string;
}): ProviderPlugin[] {
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    mode: "setup",
    includeUntrustedWorkspacePlugins: false,
    bundledProviderAllowlistCompat: true,
    bundledProviderVitestCompat: true,
  });
  const setupProviders = resolvePluginSetupRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
  }).providers.map((entry) => ({ ...entry.provider, pluginId: entry.pluginId }));
  const byId = new Map<string, ProviderPlugin>();
  for (const provider of [...providers, ...setupProviders]) {
    if (provider.auth.length > 0 && isProviderPluginAllowed(params.config, provider)) {
      byId.set(provider.id, provider);
    }
  }
  return [...byId.values()].toSorted((left, right) => left.label.localeCompare(right.label));
}

function resolveProvider(providers: readonly ProviderPlugin[], providerId: string): ProviderPlugin {
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error("Provider no longer available.");
  }
  return provider;
}

function resolveAuthMethod(provider: ProviderPlugin, methodId: string): ProviderAuthMethod {
  const method = pickAuthMethod(provider, methodId);
  if (!method) {
    throw new Error("Auth method no longer available.");
  }
  return method;
}

function applyProviderPluginEnablement(cfg: OpenClawConfig, provider: ProviderPlugin) {
  if (!provider.pluginId) {
    return cfg;
  }
  const result = enablePluginInConfig(cfg, provider.pluginId);
  if (!result.enabled) {
    throw new Error(`${provider.label} plugin is ${result.reason ?? "disabled"}.`);
  }
  return result.config;
}

function isProviderPluginAllowed(cfg: OpenClawConfig, provider: ProviderPlugin): boolean {
  if (!provider.pluginId) {
    return true;
  }
  return enablePluginInConfig(cfg, provider.pluginId).enabled;
}

function makeProviderSetupRunner(params: {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
}) {
  return async (prompter: WizardPrompter) => {
    const providers = listSetupProviders({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
    });
    if (providers.length === 0) {
      await prompter.note("No setup-capable model providers are available.", "Providers");
      return;
    }
    const providerId = await prompter.select({
      message: "Choose provider",
      options: providers.map((provider) => ({
        value: provider.id,
        label: provider.label,
        hint: provider.auth.map((method) => method.label).join(", "),
      })),
    });
    const provider = resolveProvider(providers, providerId);
    const methodId =
      provider.auth.length === 1
        ? provider.auth[0].id
        : await prompter.select({
            message: `Auth method for ${provider.label}`,
            options: provider.auth.map((method) => ({
              value: method.id,
              label: method.label,
              hint: method.hint,
            })),
          });
    const method = resolveAuthMethod(provider, methodId);
    const proceed = await prompter.confirm({
      message: `Continue with ${provider.label} ${method.label}?`,
      initialValue: true,
    });
    if (!proceed) {
      throw new WizardCancelledError("cancelled");
    }
    const enabledConfig = applyProviderPluginEnablement(params.cfg, provider);
    const applied = await runProviderPluginAuthMethod({
      config: enabledConfig,
      runtime: defaultRuntime,
      prompter,
      method,
      agentDir: params.agentDir,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      emitNotes: true,
      allowSecretRefPrompt: false,
      openUrl: async (url) => {
        await prompter.note(url, "Open provider login URL");
      },
    });
    const applyProviderAuthConfig = (cfg: OpenClawConfig) =>
      applied.applyToConfig(applyProviderPluginEnablement(cfg, provider));
    let applyToConfig = async (cfg: OpenClawConfig) =>
      restoreConfiguredPrimaryModel(applyProviderAuthConfig(cfg), cfg);
    let defaultModel: string | undefined;
    if (applied.defaultModel) {
      const setDefault = await prompter.confirm({
        message: `Set ${applied.defaultModel} as the default model?`,
        initialValue: true,
      });
      if (setDefault) {
        const selectedDefaultModel = applied.defaultModel;
        applyToConfig = async (cfg) => {
          const nextConfig = applyDefaultModel(applyProviderAuthConfig(cfg), selectedDefaultModel);
          await runProviderModelSelectedHook({
            config: nextConfig,
            model: selectedDefaultModel,
            prompter,
            agentDir: params.agentDir,
            workspaceDir: params.workspaceDir,
          });
          return nextConfig;
        };
        defaultModel = applied.defaultModel;
      }
    }
    await updateConfig((cfg) => applyToConfig(cfg));
    await prompter.note(
      [`${provider.label} is ready.`, defaultModel ? `Default model: ${defaultModel}` : null]
        .filter(Boolean)
        .join("\n"),
      "Provider saved",
    );
  };
}

function configuredProviderLabels(
  cfg: OpenClawConfig,
  providers: readonly ProviderPlugin[],
): string[] {
  const configuredIds = Object.keys(cfg.models?.providers ?? {});
  const labelById = new Map(providers.map((provider) => [provider.id, provider.label]));
  return configuredIds.toSorted().map((id) => labelById.get(id) ?? id);
}

function renderDashboard(params: ProviderSetupCommandParams): ReplyPayload {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  const current = resolveDefaultModelForAgent({ cfg: params.cfg, agentId });
  const providers = listSetupProviders({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  const providerCount = providers.length;
  const configured = configuredProviderLabels(params.cfg, providers);
  return {
    text: [
      "Model providers",
      "",
      `Default: ${current.provider}/${current.model}`,
      `Configured: ${configured.length > 0 ? configured.join(", ") : "none"}`,
      `Setup-capable providers: ${providerCount}`,
      "",
      "Choose an action.",
    ].join("\n"),
    channelData: providerSetupChannelData([
      [buildCommandButton("Add or update provider", storeLooseCallback({ type: "start" }))],
      [buildCommandButton("Refresh", storeLooseCallback({ type: "dashboard" }))],
    ]),
  };
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function renderStep(
  sessionId: string,
  record: ProviderSetupSessionRecord,
  step: WizardStep,
): ReplyPayload {
  const title = step.title ? `${step.title}\n\n` : "";
  if (step.type === "note" || step.type === "progress" || step.type === "action") {
    const loginUrl =
      step.title === "Open provider login URL" && isHttpUrl(step.message) ? step.message : null;
    const terminalSuccess = step.title === "Provider saved";
    const buttons = [
      loginUrl ? [buildUrlButton("Open login URL", loginUrl)] : [],
      [
        buildSessionButton(record, terminalSuccess ? "Done" : "Continue", {
          type: "answer",
          sessionId,
          value: "ok",
        }),
      ],
      terminalSuccess ? [] : [buildSessionButton(record, "Cancel", { type: "cancel", sessionId })],
    ].filter((row) => row.length > 0);
    return {
      text: `${title}${step.message ?? ""}`.trim() || "Continue.",
      channelData: providerSetupChannelData(buttons),
    };
  }
  if (step.type === "confirm") {
    return {
      text: `${title}${step.message ?? "Confirm?"}`,
      channelData: providerSetupChannelData([
        [
          buildSessionButton(record, "Yes", { type: "answer", sessionId, value: true }),
          buildSessionButton(record, "No", { type: "answer", sessionId, value: false }),
        ],
        [buildSessionButton(record, "Cancel", { type: "cancel", sessionId })],
      ]),
    };
  }
  if (step.type === "select") {
    const rows =
      step.options?.map((option) => [
        buildSessionButton(record, option.label, {
          type: "answer",
          sessionId,
          value: option.value,
        }),
      ]) ?? [];
    rows.push([buildSessionButton(record, "Cancel", { type: "cancel", sessionId })]);
    return {
      text: `${title}${step.message ?? "Choose one."}`,
      channelData: providerSetupChannelData(rows),
    };
  }
  if (step.type === "text") {
    return {
      text: [
        `${title}${step.message ?? "Reply with the value."}`,
        "",
        step.sensitive
          ? "Reply in this DM. OpenClaw will delete the message after reading it when Telegram allows."
          : "Reply in this DM.",
      ].join("\n"),
      channelData: providerSetupChannelData([
        [buildSessionButton(record, "Cancel", { type: "cancel", sessionId })],
      ]),
    };
  }
  return {
    text: "This step is not supported in Telegram yet.",
    channelData: providerSetupChannelData([
      [buildSessionButton(record, "Cancel", { type: "cancel", sessionId })],
    ]),
  };
}

async function renderNext(
  sessionId: string,
  record: ProviderSetupSessionRecord,
): Promise<ReplyPayload> {
  const result = await record.session.next();
  if (result.done) {
    sessions.delete(sessionId);
    clearSessionCallbacks(record);
    if (result.status === "done") {
      return {
        text: "Provider setup complete.",
        channelData: providerSetupChannelData([
          [buildCommandButton("Back to providers", "/providers")],
        ]),
      };
    }
    return {
      text: result.status === "cancelled" ? "Provider setup cancelled." : "Provider setup failed.",
      channelData: providerSetupChannelData([
        [buildCommandButton("Back to providers", "/providers")],
      ]),
    };
  }
  if (!result.step) {
    sessions.delete(sessionId);
    clearSessionCallbacks(record);
    return {
      text: "Provider setup failed.",
      channelData: providerSetupChannelData([
        [buildCommandButton("Back to providers", "/providers")],
      ]),
    };
  }
  record.lastStep = result.step;
  refreshSessionExpiry(record);
  return renderStep(sessionId, record, result.step);
}

async function answerSession(sessionId: string, value: unknown): Promise<ReplyPayload> {
  pruneExpiredProviderSetupState(Date.now());
  const record = sessions.get(sessionId);
  if (!record) {
    return {
      text: "Provider setup expired. Start again with /providers.",
      channelData: providerSetupChannelData([[buildCommandButton("Start", "/providers start")]]),
    };
  }
  const stepId = record.lastStep?.id;
  if (!stepId) {
    return renderNext(sessionId, record);
  }
  clearSessionCallbacks(record);
  await record.session.answer(stepId, value);
  return renderNext(sessionId, record);
}

function cancelSession(sessionId: string): ReplyPayload {
  pruneExpiredProviderSetupState(Date.now());
  const record = sessions.get(sessionId);
  if (record) {
    record.session.cancel();
    sessions.delete(sessionId);
    clearSessionCallbacks(record);
  }
  return {
    text: "Provider setup cancelled.",
    channelData: providerSetupChannelData([
      [buildCommandButton("Back to providers", "/providers")],
    ]),
  };
}

function cancelExistingSessions(binding: ProviderSetupBinding) {
  for (const [sessionId, record] of sessions) {
    if (sameBinding(record.binding, binding)) {
      record.session.cancel();
      sessions.delete(sessionId);
      clearSessionCallbacks(record);
    }
  }
}

async function startSession(params: ProviderSetupCommandParams, binding: ProviderSetupBinding) {
  cancelExistingSessions(binding);
  const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
  const id = randomUUID().slice(0, 12);
  const session = new WizardSession(
    makeProviderSetupRunner({
      cfg: params.cfg,
      agentId,
      agentDir: resolveAgentDir(params.cfg, agentId),
      workspaceDir: params.workspaceDir || resolveDefaultAgentWorkspaceDir(),
    }),
  );
  const record = {
    session,
    binding,
    callbackIds: new Set<string>(),
    expiresAt: Date.now() + PROVIDER_SETUP_INTERACTION_TTL_MS,
  } satisfies ProviderSetupSessionRecord;
  sessions.set(id, record);
  return renderNext(id, record);
}

async function handleStoredCallback(
  callbackId: string,
  params: ProviderSetupCommandParams,
  binding: ProviderSetupBinding,
): Promise<ReplyPayload> {
  pruneExpiredProviderSetupState(Date.now());
  const stored = callbacks.get(callbackId);
  if (!stored) {
    callbacks.delete(callbackId);
    return {
      text: "Provider setup expired. Start again with /providers.",
      channelData: providerSetupChannelData([[buildCommandButton("Start", "/providers")]]),
    };
  }
  callbacks.delete(callbackId);
  const { callback } = stored;
  if (callback.type === "dashboard") {
    return renderDashboard(params);
  }
  if (callback.type === "start") {
    return startSession(params, binding);
  }
  if (callback.type === "cancel") {
    return cancelSession(callback.sessionId);
  }
  return answerSession(callback.sessionId, callback.value);
}

export async function handleProviderSetupCommand(
  params: ProviderSetupCommandParams,
): Promise<ReplyPayload | null> {
  if (!params.commandBody.trim().startsWith(PROVIDER_SETUP_COMMAND)) {
    return null;
  }
  if (params.channel !== "telegram") {
    return { text: "Use openclaw configure on the server for provider setup on this channel." };
  }
  if (!params.isAuthorizedSender || !params.senderIsOwner) {
    return { text: "Provider setup is only available to the Telegram owner." };
  }
  if (params.isGroup) {
    return { text: "Provider setup is only available in a private Telegram DM." };
  }
  if (
    !resolveChannelConfigWrites({
      cfg: params.cfg,
      channelId: "telegram",
      accountId: params.accountId,
    })
  ) {
    return {
      text: [
        "Provider setup is read-only because Telegram config writes are disabled.",
        "",
        "Enable config writes on the server, then retry /providers.",
      ].join("\n"),
    };
  }
  const binding = resolveBinding(params);
  if (!binding) {
    return { text: "Provider setup needs a Telegram conversation context." };
  }
  const tail = normalizeCommandTail(params.commandBody);
  const [action, sessionId, rawValue] = tail.split(/\s+/, 3);
  if (!action) {
    return renderDashboard(params);
  }
  if (action === "start") {
    return startSession(params, binding);
  }
  if (action === "c" && sessionId) {
    return handleStoredCallback(sessionId, params, binding);
  }
  if (action === "cancel" && sessionId) {
    return cancelSession(sessionId);
  }
  if (action === "next" && sessionId) {
    const value = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
    return answerSession(sessionId, value);
  }
  return renderDashboard(params);
}

export async function submitProviderSetupTextInput(params: {
  channel: string;
  accountId?: string;
  conversationId: string;
  senderId?: string;
  text: string;
}): Promise<ProviderSetupTextInputResult> {
  pruneExpiredProviderSetupState(Date.now());
  const binding: ProviderSetupBinding = {
    channel: params.channel,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    conversationId: params.conversationId,
    ...(params.senderId ? { senderId: params.senderId } : {}),
  };
  const entry = [...sessions.entries()].find(([, record]) => {
    return sameBinding(record.binding, binding) && record.lastStep?.type === "text";
  });
  if (!entry) {
    return { handled: false };
  }
  const [sessionId, record] = entry;
  const sensitive = record.lastStep?.sensitive === true;
  const reply = await answerSession(sessionId, params.text);
  return { handled: true, reply, deleteInputMessage: sensitive };
}

export const __testing = {
  clearProviderSetupSessions() {
    sessions.clear();
    callbacks.clear();
  },
  providerSetupSessionCount() {
    return sessions.size;
  },
  providerSetupCallbackCount() {
    return callbacks.size;
  },
};
