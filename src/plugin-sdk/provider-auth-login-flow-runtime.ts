import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
import {
  createProviderBrowserAuthSession,
  ProviderBrowserSignInUnavailableError,
} from "../gateway/provider-browser-auth.js";
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
import { formatProviderLoginCommand } from "../shared/provider-login-command.js";
import { buildCommandChoiceReply } from "../wizard/command-choice.js";
import type { OpenClawConfig } from "./config-contracts.js";
import type { ReplyPayload } from "./reply-payload.js";
import type { RuntimeEnv } from "./runtime-env.js";

export type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
export type { ProviderChannelLoginChoice } from "../plugins/provider-login-options.js";
export { ProviderAuthConfigApplyError, ProviderCredentialsSavedError };
export {
  decideProviderLoginSessionAdoption,
  isProviderLoginPatchPersisted,
} from "../config/sessions/auth-profile-override-provenance.js";
export {
  formatProviderLoginCompletion,
  formatProviderLoginFailure,
} from "../auto-reply/provider-login-recovery.js";
export { formatProviderLoginCommand };

type ProviderAuthLoginFlowRuntime = typeof import("../commands/models/auth.js");

type ProviderLoginReply = ReplyPayload & { text: string };

type ProviderChannelLoginPreparation =
  | { status: "reply" | "rejected"; reply: ProviderLoginReply }
  | {
      status: "ready";
      choice: ProviderChannelLoginChoice;
    };

const PROVIDER_LOGIN_FLOW_TTL_MS = 15 * 60_000;

type ProviderLoginFlowRecord = {
  providerLabel: string;
  expiresAt: number;
  signal: AbortSignal;
  cancel: (message?: string) => void;
};

type ProviderLoginFlowRegistry = {
  logins: Map<string, ProviderLoginFlowRecord>;
};

type ProviderLoginFlowReservation =
  | { status: "active"; providerLabel: string }
  | { status: "reserved"; record: ProviderLoginFlowRecord };

export function createProviderLoginFlowRegistry(): ProviderLoginFlowRegistry {
  return { logins: new Map() };
}

const loadProviderAuthLoginFlowRuntime = createLazyRuntimeModule(
  () => import("../commands/models/auth.js"),
);
const bindProviderAuthLoginFlowRuntime = createLazyRuntimeMethodBinder(
  loadProviderAuthLoginFlowRuntime,
);

export const runModelsAuthLoginFlow: ProviderAuthLoginFlowRuntime["runModelsAuthLoginFlowCore"] =
  bindProviderAuthLoginFlowRuntime((runtime) => runtime.runModelsAuthLoginFlowCore);

export function reserveProviderLoginFlow(params: {
  flows: ProviderLoginFlowRegistry;
  flowKey: string;
  providerLabel: string;
  now?: number;
  replacementMessage?: string;
  signal?: AbortSignal;
}): ProviderLoginFlowReservation {
  const now = params.now ?? Date.now();
  const activeFlow = params.flows.logins.get(params.flowKey);
  if (activeFlow && activeFlow.expiresAt > now) {
    return { status: "active", providerLabel: activeFlow.providerLabel };
  }
  if (activeFlow) {
    activeFlow.cancel();
    params.flows.logins.delete(params.flowKey);
  }
  const abortController = new AbortController();
  const signal = AbortSignal.any([
    abortController.signal,
    AbortSignal.timeout(PROVIDER_LOGIN_FLOW_TTL_MS),
    ...(params.signal ? [params.signal] : []),
  ]);
  const record: ProviderLoginFlowRecord = {
    providerLabel: params.providerLabel,
    expiresAt: now + PROVIDER_LOGIN_FLOW_TTL_MS,
    signal,
    cancel: (message?: string) =>
      abortController.abort(
        new Error(
          message ?? params.replacementMessage ?? "Provider login was replaced by a newer flow.",
        ),
      ),
  };
  signal.addEventListener(
    "abort",
    () => {
      if (params.flows.logins.get(params.flowKey) === record) {
        params.flows.logins.delete(params.flowKey);
      }
    },
    { once: true },
  );
  if (!signal.aborted) {
    params.flows.logins.set(params.flowKey, record);
  }
  return { status: "reserved", record };
}

export function releaseProviderLoginFlow(params: {
  flows: ProviderLoginFlowRegistry;
  flowKey: string;
  record: ProviderLoginFlowRecord;
}): void {
  if (params.flows.logins.get(params.flowKey) === params.record) {
    params.flows.logins.delete(params.flowKey);
  }
  params.record.cancel();
}

export function cancelProviderLoginFlow(params: {
  flows: ProviderLoginFlowRegistry;
  flowKey: string;
}): boolean {
  const record = params.flows.logins.get(params.flowKey);
  params.flows.logins.delete(params.flowKey);
  record?.cancel("Provider login cancelled from chat.");
  return record !== undefined;
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
  refreshAuth: () => Promise<void>;
  cancelLogin?: () => ReturnType<typeof cancelProviderLoginFlow>;
}): Promise<ProviderChannelLoginPreparation | null> {
  const match = params.commandText.trim().match(/^\/login(?:\s+(.+))?$/u);
  if (!match) {
    return null;
  }
  params.signal?.throwIfAborted();
  if (
    !params.hasAdminScope &&
    !params.config.commands?.ownerAllowFrom?.some((owner) => normalizeOptionalString(String(owner)))
  ) {
    return {
      status: "rejected",
      reply: {
        text: "No chat owner is configured. Ask the OpenClaw owner to add your chat account to `commands.ownerAllowFrom` in the OpenClaw configuration, then send `/login` again.",
      },
    };
  }
  if (!params.commandAuthorized || !params.senderIsOwner) {
    return {
      status: "rejected",
      reply: {
        text: "Only an OpenClaw owner can sign in here. Ask the owner to connect this provider or grant you owner access.",
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
  if (match[1]?.trim().toLowerCase() === "refresh") {
    try {
      await params.refreshAuth();
      return {
        status: "reply",
        reply: { text: "Sign-in status refreshed. Send /models to see available models." },
      };
    } catch {
      return {
        status: "reply",
        reply: {
          text: "Your saved connections could not be applied. Send /login refresh to try again. You do not need to sign in again.",
        },
      };
    }
  }
  if (match[1]?.trim().toLowerCase() === "cancel") {
    const cancelled = params.cancelLogin?.();
    return {
      status: "reply",
      reply: {
        text: cancelled
          ? "Provider login cancelled for this chat."
          : "No provider login is active in this chat.",
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
  const access: unknown = result.modelAccess;
  let modelAccess: ModelsAuthLoginFlowResult["modelAccess"];
  if (access !== undefined) {
    if (
      !access ||
      typeof access !== "object" ||
      !("message" in access) ||
      !("applied" in access) ||
      typeof access.message !== "string" ||
      typeof access.applied !== "boolean"
    ) {
      throw new Error("Provider login returned an invalid model access result.");
    }
    modelAccess = { message: access.message, applied: access.applied };
  }
  return {
    providerId,
    methodId,
    authRefresh,
    ...(defaultModel ? { defaultModel } : {}),
    ...(modelAccess ? { modelAccess } : {}),
    profiles,
  };
}

export async function refreshProviderLoginAuthState(params: {
  agentId: string;
  readConfig: () => OpenClawConfig;
  assertCurrent: (config: OpenClawConfig) => void;
}): Promise<void> {
  const readConfig = () => {
    const config = params.readConfig();
    params.assertCurrent(config);
    return config;
  };
  readConfig();
  const { refreshModelAuthStateAfterMutation } = await import("../gateway/model-auth-refresh.js");
  readConfig();
  await refreshModelAuthStateAfterMutation(readConfig, params.agentId);
  readConfig();
}

export async function runProviderChannelLoginFlow(params: {
  choice: ProviderChannelLoginChoice;
  agentId: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  sendMessage: (message: string) => Promise<void>;
  sendReply?: (reply: ProviderLoginReply) => Promise<void> | void;
  sendDeviceCode?: NonNullable<ModelsAuthLoginFlowOptions["prompter"]["deviceCode"]>;
  signal?: AbortSignal;
  readConfig?: () => OpenClawConfig;
  assertCurrent?: (config: OpenClawConfig) => void;
  unsupportedPromptMessage: string;
  runLoginFlow?: (opts: ModelsAuthLoginFlowOptions) => Promise<unknown>;
}): Promise<ModelsAuthLoginFlowResult> {
  const openUrl = async (url: string) => {
    assertCurrent();
    const heading = `Sign in with ${params.choice.providerLabel}. Return here after approving access. Send /login cancel to cancel.`;
    const text = `${heading}\n${url}`;
    if (params.sendReply) {
      await params.sendReply({
        text,
        presentationTextMode: "fallback",
        presentation: {
          blocks: [
            { type: "text", text: heading },
            {
              type: "buttons",
              buttons: [
                {
                  label: `Sign in with ${params.choice.providerLabel}`,
                  action: { type: "url", url },
                },
              ],
            },
          ],
        },
      });
    } else {
      await params.sendMessage(text);
    }
    assertCurrent();
  };
  const browser = createProviderBrowserAuthSession({ signal: params.signal, openUrl });
  const readConfig = params.readConfig ?? (() => params.config);
  const assertCurrent = () => {
    browser.assertCurrent();
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
  try {
    assertCurrent();
    const choice = params.choice;
    const result = await (params.runLoginFlow ?? runModelsAuthLoginFlow)({
      provider: choice.providerId,
      method: choice.methodId,
      ownerPluginId: choice.pluginId,
      credentialOnly: true,
      refreshAfterLogin: (agentId) =>
        refreshProviderLoginAuthState({ agentId, readConfig, assertCurrent }),
      assertCurrent,
      agent: params.agentId,
      config: readConfig(),
      runtime: params.runtime,
      signal: browser.signal,
      browserAuthorization: async (request) => {
        assertCurrent();
        try {
          return await browser.authorize(request);
        } catch (error) {
          if (error instanceof ProviderBrowserSignInUnavailableError) {
            await params.sendMessage(error.message);
          }
          throw error;
        }
      },
      beforePersistentEffect: assertCurrent,
      prompter: buildProviderChannelLoginPrompter({ ...params, assertCurrent }),
      isRemote: true,
      openUrl,
    });
    return parseModelsAuthLoginFlowResult(result);
  } finally {
    browser.close();
  }
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
            command: formatProviderLoginCommand(formatProviderOAuthLoginRef(provider)),
          },
        }))
      : resolution.choices
          .toSorted((left, right) => Number(right.mode === "chat") - Number(left.mode === "chat"))
          .map((choice) => ({
            label: choice.label,
            action: {
              type: "command" as const,
              command: formatProviderLoginCommand(formatProviderLoginChoiceRef(choice)),
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
        : "No provider matched that name. Available connections:";
  return buildCommandChoiceReply(heading, buttons);
}
