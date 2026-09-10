import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  formatProviderLoginChoiceRef,
  formatProviderOAuthLoginRef,
  resolveProviderChannelLoginChoice,
  type ProviderChannelLoginChoice,
  type ProviderChannelLoginResolution,
} from "../plugins/provider-login-options.js";
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  ProviderAuthConfigApplyError,
  ProviderCredentialsSavedError,
} from "../shared/provider-auth-result.js";
import type { OpenClawConfig } from "./config-contracts.js";
import type { ReplyPayload } from "./reply-payload.js";
import type { RuntimeEnv } from "./runtime-env.js";

export type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
export type { ProviderChannelLoginChoice } from "../plugins/provider-login-options.js";
export { ProviderAuthConfigApplyError, ProviderCredentialsSavedError };

type ProviderAuthLoginFlowRuntime = typeof import("../commands/models/auth.js");

type ProviderLoginReply = ReplyPayload & { text: string };

type ProviderChannelLoginPreparation =
  | { status: "reply" | "rejected"; reply: ProviderLoginReply }
  | {
      status: "ready";
      choice: ProviderChannelLoginChoice;
    };

type ProviderLoginSessionEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "providerOverride"
  | "modelProvider"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
>;

type ProviderLoginSessionAdoption =
  | { status: "unchanged" }
  | {
      status: "patch";
      patch: {
        authProfileOverride: string;
        authProfileOverrideSource: "user";
        authProfileOverrideCompactionCount: undefined;
      };
    }
  | { status: "rejected" };

const PROVIDER_LOGIN_FLOW_TTL_MS = 15 * 60_000;

type ProviderLoginFlowRecord = {
  expiresAt: number;
  signal: AbortSignal;
  cancel: () => void;
};

type ProviderLoginFlowReservation =
  | { status: "active" }
  | { status: "reserved"; record: ProviderLoginFlowRecord };

export function createProviderLoginFlowRegistry(): Map<string, ProviderLoginFlowRecord> {
  return new Map();
}

const loadProviderAuthLoginFlowRuntime = createLazyRuntimeModule(
  () => import("../commands/models/auth.js"),
);
const bindProviderAuthLoginFlowRuntime = createLazyRuntimeMethodBinder(
  loadProviderAuthLoginFlowRuntime,
);

export const runModelsAuthLoginFlow: ProviderAuthLoginFlowRuntime["runModelsAuthLoginFlowCore"] =
  bindProviderAuthLoginFlowRuntime((runtime) => runtime.runModelsAuthLoginFlowCore);

function matchesLoginSnapshot(
  current: ProviderLoginSessionEntry,
  snapshot: ProviderLoginSessionEntry,
): boolean {
  return (
    current.sessionId === snapshot.sessionId &&
    current.authProfileOverride === snapshot.authProfileOverride &&
    current.authProfileOverrideSource === snapshot.authProfileOverrideSource &&
    current.authProfileOverrideCompactionCount === snapshot.authProfileOverrideCompactionCount
  );
}

function resolvePersistedModelProvider(entry: ProviderLoginSessionEntry): string | undefined {
  const provider = normalizeLowercaseStringOrEmpty(entry.providerOverride ?? entry.modelProvider);
  return provider || undefined;
}

/** Decide one session-profile adoption from the authoritative row read immediately before write. */
export function decideProviderLoginSessionAdoption(params: {
  currentModelProvider: string | undefined;
  loginProvider: string;
  nextProfileId: string | undefined;
  snapshot: ProviderLoginSessionEntry | undefined;
  current: ProviderLoginSessionEntry | undefined;
}): ProviderLoginSessionAdoption {
  if (!params.nextProfileId) {
    return { status: "rejected" };
  }
  if (
    !params.currentModelProvider ||
    normalizeLowercaseStringOrEmpty(params.currentModelProvider) !==
      normalizeLowercaseStringOrEmpty(params.loginProvider) ||
    !params.current
  ) {
    return { status: "unchanged" };
  }
  const currentProvider = resolvePersistedModelProvider(params.current);
  const snapshotProvider = params.snapshot
    ? resolvePersistedModelProvider(params.snapshot)
    : undefined;
  if (
    (currentProvider &&
      currentProvider !== normalizeLowercaseStringOrEmpty(params.loginProvider)) ||
    (params.snapshot && currentProvider !== snapshotProvider)
  ) {
    return { status: "unchanged" };
  }
  if (params.snapshot) {
    if (!matchesLoginSnapshot(params.current, params.snapshot)) {
      return { status: "rejected" };
    }
  } else {
    const source = resolveCollapsedSessionAuthPinSource(params.current);
    if (source === "user" && params.current.authProfileOverride !== params.nextProfileId) {
      return { status: "rejected" };
    }
  }
  const needsPatch =
    params.current.authProfileOverride !== params.nextProfileId ||
    params.current.authProfileOverrideSource !== "user" ||
    params.current.authProfileOverrideCompactionCount !== undefined;
  return needsPatch
    ? {
        status: "patch",
        patch: {
          authProfileOverride: params.nextProfileId,
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: undefined,
        },
      }
    : { status: "unchanged" };
}

export function reserveProviderLoginFlow(params: {
  flows: Map<string, ProviderLoginFlowRecord>;
  flowKey: string;
  now?: number;
  replacementMessage?: string;
}): ProviderLoginFlowReservation {
  const now = params.now ?? Date.now();
  const activeFlow = params.flows.get(params.flowKey);
  if (activeFlow && activeFlow.expiresAt > now) {
    return { status: "active" };
  }
  if (activeFlow) {
    activeFlow.cancel();
    params.flows.delete(params.flowKey);
  }
  const abortController = new AbortController();
  const record = {
    expiresAt: now + PROVIDER_LOGIN_FLOW_TTL_MS,
    signal: abortController.signal,
    cancel: () =>
      abortController.abort(
        new Error(params.replacementMessage ?? "Provider login was replaced by a newer flow."),
      ),
  };
  params.flows.set(params.flowKey, record);
  return { status: "reserved", record };
}

export function releaseProviderLoginFlow(params: {
  flows: Map<string, ProviderLoginFlowRecord>;
  flowKey: string;
  record: ProviderLoginFlowRecord;
}): void {
  if (params.flows.get(params.flowKey) === params.record) {
    params.flows.delete(params.flowKey);
  }
}

export async function prepareProviderChannelLogin(params: {
  commandText: string;
  commandAuthorized: boolean;
  senderIsOwner: boolean;
  isPrivateChat: boolean;
  config: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  signal?: AbortSignal;
  hasAdminScope?: boolean;
}): Promise<ProviderChannelLoginPreparation | null> {
  const match = params.commandText.trim().match(/^\/login(?:\s+(.+))?$/u);
  if (!match) {
    return null;
  }
  params.signal?.throwIfAborted();
  if (
    !params.commandAuthorized ||
    !params.senderIsOwner ||
    (!params.hasAdminScope &&
      !params.config.commands?.ownerAllowFrom?.some((owner) =>
        normalizeOptionalString(String(owner)),
      ))
  ) {
    return {
      status: "rejected",
      reply: {
        text: "Only a configured OpenClaw owner/admin can start provider login from this channel.",
      },
    };
  }
  if (!params.isPrivateChat) {
    return {
      status: "reply",
      reply: {
        text: "Provider login requires a private chat or Control UI session. Open a private chat with OpenClaw and send `/login` there.",
      },
    };
  }
  const resolution = resolveProviderChannelLoginChoice(match[1]?.trim() || undefined, {
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  if (resolution.status !== "resolved") {
    return { status: "reply", reply: buildProviderLoginChoicesReply(resolution) };
  }
  const choice = resolution.choice;
  if (choice.mode !== "chat") {
    return { status: "reply", reply: { text: formatProviderLoginControlUiHandoff(choice) } };
  }
  return { status: "ready", choice };
}

function buildProviderChannelLoginPrompter(params: {
  sendMessage: (message: string) => Promise<void>;
  sendDeviceCode?: NonNullable<ModelsAuthLoginFlowOptions["prompter"]["deviceCode"]>;
  assertCurrent: () => void;
  unsupportedPromptMessage: string;
}): ModelsAuthLoginFlowOptions["prompter"] {
  const sendCleanMessage = async (message: string) => {
    params.assertCurrent();
    const text = message.trim();
    if (text) {
      await params.sendMessage(text);
      params.assertCurrent();
    }
  };
  const sendDeviceCode = params.sendDeviceCode;
  const unsupportedPrompt = async () => {
    await sendCleanMessage(params.unsupportedPromptMessage);
    throw new Error(params.unsupportedPromptMessage);
  };
  return {
    intro: async () => {},
    outro: async () => {},
    note: async (message, title) => {
      await sendCleanMessage([title?.trim(), message.trim()].filter(Boolean).join("\n\n"));
    },
    ...(sendDeviceCode
      ? {
          deviceCode: async (deviceCode) => {
            params.assertCurrent();
            await sendDeviceCode(deviceCode);
            params.assertCurrent();
          },
        }
      : {}),
    plain: sendCleanMessage,
    select: unsupportedPrompt,
    multiselect: unsupportedPrompt,
    text: unsupportedPrompt,
    confirm: unsupportedPrompt,
    progress: () => ({
      update: () => {},
      stop: () => {},
    }),
  };
}

function parseModelsAuthLoginFlowResult(value: unknown): ModelsAuthLoginFlowResult {
  if (!value || typeof value !== "object") {
    throw new Error("Provider login returned an invalid result.");
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.profiles)) {
    throw new Error("Provider login returned an invalid result.");
  }
  const parseRequiredString = (input: unknown, label: string): string => {
    if (typeof input !== "string" || !input.trim()) {
      throw new Error(`Provider login returned an invalid ${label}.`);
    }
    return input.trim();
  };
  const providerId = parseRequiredString(result.providerId, "provider id");
  const methodId = parseRequiredString(result.methodId, "method id");
  const authRefresh = result.authRefresh;
  if (
    authRefresh !== "refreshed" &&
    authRefresh !== "gateway-rejected" &&
    authRefresh !== "gateway-unreachable"
  ) {
    throw new Error("Provider login returned an invalid auth refresh outcome.");
  }
  const profiles = result.profiles.map((profile): ModelsAuthLoginFlowResult["profiles"][number] => {
    if (!profile || typeof profile !== "object") {
      throw new Error("Provider login returned an invalid profile.");
    }
    const record = profile as Record<string, unknown>;
    const profileId = parseRequiredString(record.profileId, "profile id");
    const provider = parseRequiredString(record.provider, "profile provider");
    const mode = parseRequiredString(record.mode, "profile mode");
    if (mode !== "api_key" && mode !== "oauth" && mode !== "token") {
      throw new Error("Provider login returned an invalid profile.");
    }
    return {
      profileId,
      provider,
      mode,
    };
  });
  const defaultModel =
    result.defaultModel === undefined
      ? undefined
      : parseRequiredString(result.defaultModel, "default model");
  return {
    providerId,
    methodId,
    authRefresh,
    ...(defaultModel ? { defaultModel } : {}),
    profiles,
  };
}

export async function runProviderChannelLoginFlow(params: {
  choice: ProviderChannelLoginChoice;
  agentId: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  sendMessage: (message: string) => Promise<void>;
  sendDeviceCode?: NonNullable<ModelsAuthLoginFlowOptions["prompter"]["deviceCode"]>;
  signal?: AbortSignal;
  readConfig?: () => OpenClawConfig;
  assertCurrent?: (config: OpenClawConfig) => void;
  unsupportedPromptMessage: string;
  runLoginFlow?: (opts: ModelsAuthLoginFlowOptions) => Promise<unknown>;
}): Promise<ModelsAuthLoginFlowResult> {
  const readConfig = params.readConfig ?? (() => params.config);
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    const config = readConfig();
    params.assertCurrent?.(config);
    const resolution = resolveProviderChannelLoginChoice(
      formatProviderLoginChoiceRef(params.choice),
      { config },
    );
    if (
      resolution.status !== "resolved" ||
      resolution.choice.mode !== "chat" ||
      resolution.choice.pluginId !== params.choice.pluginId ||
      resolution.choice.providerId !== params.choice.providerId ||
      resolution.choice.methodId !== params.choice.methodId
    ) {
      throw new Error("This provider login is no longer available. Send /login to choose again.");
    }
  };
  assertCurrent();
  const choice = params.choice;
  const result = await (params.runLoginFlow ?? runModelsAuthLoginFlow)({
    provider: choice.providerId,
    method: choice.methodId,
    ownerPluginId: choice.pluginId,
    credentialOnly: true,
    assertCurrent,
    agent: params.agentId,
    config: readConfig(),
    runtime: params.runtime,
    signal: params.signal,
    beforePersistentEffect: assertCurrent,
    prompter: buildProviderChannelLoginPrompter({ ...params, assertCurrent }),
    isRemote: true,
    openUrl: async (url) => {
      assertCurrent();
      await params.sendMessage(url);
      assertCurrent();
    },
  });
  return parseModelsAuthLoginFlowResult(result);
}

export function formatProviderLoginCommand(choice: ProviderChannelLoginChoice): string {
  return `/login ${choice.command}`;
}

export function formatProviderLoginCompletion(
  choice: ProviderChannelLoginChoice,
  authRefresh: ModelsAuthLoginFlowResult["authRefresh"],
  sessionSwitchFailed = false,
  sessionLabel = "session",
): string {
  const sessionFailure = `this ${sessionLabel} could not switch to the newly authenticated profile. Retry \`${formatProviderLoginCommand(choice)}\`, or select the profile manually.`;
  if (authRefresh === "refreshed") {
    return sessionSwitchFailed
      ? `${choice.providerLabel} login completed, but ${sessionFailure}`
      : `${choice.providerLabel} login complete. Try your request again now.`;
  }
  const message =
    authRefresh === "gateway-rejected"
      ? `${choice.providerLabel} credentials saved, but the Gateway could not apply the auth update. Check the Gateway logs, restart the Gateway, then use /models.`
      : `${choice.providerLabel} credentials saved, but the Gateway could not be reached to apply them. Restart the Gateway, then use /models.`;
  return sessionSwitchFailed ? `${message} Also, ${sessionFailure}` : message;
}

export function formatProviderLoginFailure(
  choice: ProviderChannelLoginChoice,
  error: unknown,
): string {
  if (error instanceof ProviderAuthConfigApplyError) {
    return `${choice.providerLabel} credentials saved, but provider settings could not be applied. Review the provider settings and check the Gateway logs before trying again.`;
  }
  if (error instanceof ProviderCredentialsSavedError) {
    return `${choice.providerLabel} credentials were saved, but sign-in did not finish. Send \`${formatProviderLoginCommand(choice)}\` to retry.`;
  }
  return `${choice.providerLabel} login did not complete. Send \`${formatProviderLoginCommand(choice)}\` to try again.`;
}

function formatProviderLoginControlUiHandoff(choice: ProviderChannelLoginChoice): string {
  if (choice.mode === "setup") {
    return `${choice.label} needs provider setup. Open Control UI → Models → Configure Models, then choose “${choice.label}”.`;
  }
  return choice.mode === "secret"
    ? `${choice.label} needs secure input that chat must not store. Open Control UI → Models → Connect provider, then choose “${choice.label}”.`
    : `${choice.label} needs provider sign-in. Open Control UI → Models → Connect provider, then choose “${choice.label}”.`;
}

export function buildProviderLoginChoicesReply(
  resolution: Exclude<ProviderChannelLoginResolution, { status: "resolved" }>,
): ProviderLoginReply {
  const buttons =
    resolution.status === "providers"
      ? resolution.providers.map((provider) => ({
          label: provider.label,
          action: {
            type: "command" as const,
            command: `/login ${formatProviderOAuthLoginRef(provider)}`,
          },
        }))
      : resolution.choices
          .toSorted((left, right) => Number(right.mode === "chat") - Number(left.mode === "chat"))
          .map((choice) => ({
            label: choice.label,
            action: {
              type: "command" as const,
              command: `/login ${formatProviderLoginChoiceRef(choice)}`,
            },
          }));
  if (buttons.length === 0) {
    return {
      text:
        resolution.status === "providers"
          ? "No OAuth sign-in providers are available. Use /login <provider> for other connection options."
          : "No provider connections are available. Enable a provider plugin in Control UI → Models.",
    };
  }
  const heading =
    resolution.status === "providers"
      ? "Choose a provider to sign in:"
      : resolution.status === "ambiguous"
        ? "Choose how to connect:"
        : "Unsupported login provider. Available provider access commands:";
  return {
    text: [heading, ...buttons.map((button) => `${button.label}: \`${button.action.command}\``)]
      .filter(Boolean)
      .join("\n"),
    presentationTextMode: "fallback",
    presentation: {
      blocks: [
        { type: "text", text: heading },
        { type: "buttons", buttons },
      ],
    },
  };
}

/** A persisted row proves a patch only when it carries the exact login profile we wrote. */
export function isProviderLoginPatchPersisted(
  persisted: ProviderLoginSessionEntry,
  nextProfileId: string,
): boolean {
  return (
    persisted.authProfileOverride === nextProfileId &&
    persisted.authProfileOverrideSource === "user" &&
    persisted.authProfileOverrideCompactionCount === undefined
  );
}
