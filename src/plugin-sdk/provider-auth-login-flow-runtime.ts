import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { PROVIDER_LOGIN_NEEDS_APP } from "../auto-reply/provider-login-recovery.js";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
import { createProviderBrowserAuthSession } from "../gateway/provider-browser-auth.js";
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
        text: "Provider login requires a private chat or the OpenClaw app. Open a private chat with OpenClaw and send `/login` there.",
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

/** `assertLive` stops delivery once the login is cancelled or ended; it is not an authority check. */
function buildProviderChannelLoginPrompter(params: {
  sendMessage: (message: string) => Promise<void>;
  sendDeviceCode?: NonNullable<ModelsAuthLoginFlowOptions["prompter"]["deviceCode"]>;
  assertLive: () => void;
}): ModelsAuthLoginFlowOptions["prompter"] {
  const sendCleanMessage = async (message: string) => {
    params.assertLive();
    const text = message.trim();
    if (text) {
      await params.sendMessage(text);
    }
  };
  const sendDeviceCode = params.sendDeviceCode;
  // Chat cannot collect input; the failure renderer tells the user to open the app.
  const unsupportedPrompt = async () => {
    throw new Error(PROVIDER_LOGIN_NEEDS_APP);
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
            params.assertLive();
            await sendDeviceCode(deviceCode);
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

export async function refreshProviderLoginAuthState(params: {
  agentId: string;
  readConfig: () => OpenClawConfig;
}): Promise<void> {
  const { refreshModelAuthStateAfterMutation } = await import("../gateway/model-auth-refresh.js");
  await refreshModelAuthStateAfterMutation(params.readConfig, params.agentId);
}

/** Authority was checked once when `/login` started; a started sign-in may finish. */
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
  runLoginFlow?: typeof runModelsAuthLoginFlow;
}): Promise<ModelsAuthLoginFlowResult> {
  const openUrl = async (url: string) => {
    browser.assertCurrent();
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
  };
  const browser = createProviderBrowserAuthSession({ signal: params.signal, openUrl });
  const readConfig = params.readConfig ?? (() => params.config);
  try {
    const choice = params.choice;
    const { createProviderAuthNodes } = await import("../gateway/server-plugins.js");
    return await (params.runLoginFlow ?? runModelsAuthLoginFlow)({
      provider: choice.providerId,
      method: choice.methodId,
      ownerPluginId: choice.pluginId,
      credentialOnly: true,
      refreshAfterLogin: (agentId) => refreshProviderLoginAuthState({ agentId, readConfig }),
      assertCurrent: browser.assertCurrent,
      agent: params.agentId,
      config: readConfig(),
      runtime: params.runtime,
      signal: browser.signal,
      browserAuthorization: browser.authorize,
      prompter: buildProviderChannelLoginPrompter({ ...params, assertLive: browser.assertCurrent }),
      isRemote: true,
      openUrl,
      nodes: createProviderAuthNodes(),
    });
  } finally {
    browser.close();
  }
}

function formatProviderLoginControlUiHandoff(choice: ProviderChannelLoginChoice): string {
  if (choice.mode === "setup") {
    return `${choice.label} needs provider setup. In the OpenClaw app, open Models → Configure Models, then choose “${choice.label}”.`;
  }
  return choice.mode === "secret"
    ? `${choice.label} needs secure input that chat must not store. In the OpenClaw app, open Models → Connect provider, then choose “${choice.label}”.`
    : `${choice.label} needs provider sign-in. In the OpenClaw app, open Models → Connect provider, then choose “${choice.label}”.`;
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
          : "No provider connections are available. Enable a provider plugin under Models in the OpenClaw app.",
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
