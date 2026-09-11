import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  cancelProviderLoginFlow,
  decideProviderLoginSessionAdoption,
  createProviderLoginFlowRegistry,
  formatProviderLoginCommand,
  formatProviderLoginCompletion,
  formatProviderLoginFailure,
  isProviderLoginPatchPersisted,
  prepareProviderChannelLogin,
  releaseProviderLoginFlow,
  reserveProviderLoginFlow,
  runProviderChannelLoginFlow,
  type ProviderChannelLoginChoice,
} from "../../plugin-sdk/provider-auth-login-flow-runtime.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { isConfiguredCommandOwner } from "../command-auth.js";
import type { ReplyPayload } from "../types.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const PRIVATE_CHAT_TYPES = new Set(["direct", "dm", "im", "private"]);
const PUBLIC_CHAT_TYPES = new Set(["channel", "forum", "group", "public", "supergroup", "topic"]);
const WEB_LOGIN_SURFACES = new Set(["control", "control-ui", "dashboard", "internal", "web"]);

const activeProviderLoginFlows = createProviderLoginFlowRegistry();

function normalizeSurface(value: unknown): string {
  return normalizeLowercaseStringOrEmpty(normalizeOptionalString(value) ?? "").replace(/_/gu, "-");
}

function hasPrivateTarget(value: unknown): boolean {
  const normalized = normalizeSurface(value);
  return /^(?:direct|dm|im|private|user):/u.test(normalized);
}

function hasPublicTarget(value: unknown): boolean {
  const normalized = normalizeSurface(value);
  return /^(?:channel|forum|group|guild|public|room|topic):/u.test(normalized);
}

function isPrivateLoginContext(params: HandleCommandsParams): boolean {
  const surface = normalizeSurface(
    params.command.channel || params.command.surface || params.ctx.Surface,
  );
  if (WEB_LOGIN_SURFACES.has(surface)) {
    return true;
  }
  if (params.isGroup) {
    return false;
  }
  const chatType = normalizeSurface(params.ctx.ChatType);
  if (PRIVATE_CHAT_TYPES.has(chatType)) {
    return true;
  }
  if (PUBLIC_CHAT_TYPES.has(chatType)) {
    return false;
  }
  const targets = [
    params.ctx.OriginatingTo,
    params.ctx.To,
    params.command.to,
    params.command.from,
    params.ctx.From,
  ];
  if (targets.some(hasPrivateTarget)) {
    return true;
  }
  if (targets.some(hasPublicTarget)) {
    return false;
  }
  return false;
}

function keyPart(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value.trim() || fallback;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

function buildProviderLoginFlowKey(params: HandleCommandsParams): string {
  const threadId =
    params.ctx.MessageThreadId ?? params.ctx.TransportThreadId ?? params.ctx.ThreadParentId;
  return [
    "channel-login",
    keyPart(params.command.channel || params.ctx.Surface || params.ctx.Provider, "unknown"),
    keyPart(params.command.accountId ?? params.ctx.AccountId, "default"),
    keyPart(params.ctx.OriginatingTo ?? params.command.to ?? params.command.channelId, "unknown"),
    keyPart(threadId, "main"),
    params.agentId,
    params.sessionKey,
  ].join(":");
}

async function emitLoginMessage(params: HandleCommandsParams, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  if (params.opts?.onBlockReply) {
    await params.opts.onBlockReply({ text: trimmed });
    return;
  }
  throw new Error("Channel /login requires immediate block delivery for device codes.");
}

async function switchLoginSessionProfile(params: {
  commandParams: HandleCommandsParams;
  loginProvider: string;
  nextProfileId: string | undefined;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<"unchanged" | "updated" | "failed"> {
  const { commandParams, loginProvider, nextProfileId } = params;
  const currentEntry = commandParams.sessionEntry;
  if (!nextProfileId) {
    return "failed";
  }
  if (!currentEntry) {
    return "unchanged";
  }
  if (normalizeSurface(commandParams.provider) !== normalizeSurface(loginProvider)) {
    return "unchanged";
  }

  const sessionStore = commandParams.sessionStore;
  if (!sessionStore) {
    return "failed";
  }
  const liveEntry = sessionStore[commandParams.sessionKey];
  if (!liveEntry) {
    return "failed";
  }
  const liveDecision = decideProviderLoginSessionAdoption({
    currentModelProvider: commandParams.provider,
    loginProvider,
    nextProfileId,
    snapshot: currentEntry,
    current: liveEntry,
  });
  if (liveDecision.status === "rejected") {
    return "failed";
  }
  if (liveDecision.status === "unchanged" && !commandParams.storePath) {
    return "unchanged";
  }

  const nextEntry =
    liveDecision.status === "patch" ? { ...liveEntry, ...liveDecision.patch } : liveEntry;
  try {
    let finalDecision = liveDecision;
    let persistedEntry: SessionEntry = nextEntry;
    if (commandParams.storePath) {
      let persistedDecision: ReturnType<typeof decideProviderLoginSessionAdoption> | undefined;
      const persisted = await patchSessionEntryCore(
        {
          storePath: commandParams.storePath,
          sessionKey: commandParams.sessionKey,
        },
        (entry) => {
          persistedDecision = decideProviderLoginSessionAdoption({
            currentModelProvider: commandParams.provider,
            loginProvider,
            nextProfileId,
            snapshot: currentEntry,
            current: entry,
          });
          return persistedDecision.status === "patch" ? persistedDecision.patch : null;
        },
        {
          assertCommitAllowed: () => {
            params.signal.throwIfAborted();
            params.assertCurrent();
          },
          requireWriteSuccess: true,
          skipMaintenance: true,
        },
      );
      if (
        !persistedDecision ||
        persistedDecision.status === "rejected" ||
        !persisted ||
        (persistedDecision.status === "patch" &&
          !isProviderLoginPatchPersisted(persisted, nextProfileId))
      ) {
        return "failed";
      }
      finalDecision = persistedDecision;
      persistedEntry = persisted;
    } else {
      params.signal.throwIfAborted();
      params.assertCurrent();
    }
    commandParams.sessionEntry = persistedEntry;
    sessionStore[commandParams.sessionKey] = persistedEntry;
    if (finalDecision.status === "patch") {
      markCommandSessionMetadataChanged(commandParams);
      return "updated";
    }
    return "unchanged";
  } catch {
    // Credential persistence already succeeded, so report partial success.
  }
  return "failed";
}

async function runChannelProviderLogin(params: {
  commandParams: HandleCommandsParams;
  choice: ProviderChannelLoginChoice;
  agentId: string;
  runtime?: RuntimeEnv;
}): Promise<ReplyPayload> {
  const flowKey = buildProviderLoginFlowKey(params.commandParams);
  const sendReply = params.commandParams.opts?.onBlockReply;
  if (!sendReply) {
    return {
      text: `${params.choice.providerLabel} login needs a live private response path so the code can be shown before it expires. Use the Control UI or a private chat and send \`${formatProviderLoginCommand(params.choice)}\` again.`,
    };
  }

  const reservation = reserveProviderLoginFlow({
    flows: activeProviderLoginFlows,
    flowKey,
  });
  if (reservation.status === "active") {
    return {
      text: "A provider login is already active for this chat. Complete it, or send `/login cancel` before requesting a new one.",
    };
  }

  const commandSignal = params.commandParams.opts?.abortSignal;
  const flowSignal = commandSignal
    ? AbortSignal.any([reservation.record.signal, commandSignal])
    : reservation.record.signal;
  const readConfig =
    params.commandParams.opts?.getProviderLoginConfig ??
    (() => getRuntimeConfigSnapshot() ?? params.commandParams.cfg);
  const assertCurrent = (config = readConfig()) => {
    const assertAuthority = params.commandParams.opts?.assertProviderLoginAuthority;
    if (assertAuthority) {
      assertAuthority();
      return;
    }
    if (!isConfiguredCommandOwner(config, params.commandParams.command)) {
      throw new Error("Provider login authority is no longer active.");
    }
  };
  try {
    const loginResult = await runProviderChannelLoginFlow({
      choice: params.choice,
      agentId: params.agentId,
      config: params.commandParams.cfg,
      readConfig,
      runtime: params.runtime ?? defaultRuntime,
      signal: flowSignal,
      assertCurrent,
      sendMessage: async (text) => await emitLoginMessage(params.commandParams, text),
      sendReply,
      unsupportedPromptMessage:
        "This provider needs input that chat cannot collect. Open Control UI → Models and choose Sign in.",
    });
    flowSignal.throwIfAborted();
    const nextProfileId = loginResult.profiles.find(
      (profile) =>
        normalizeSurface(profile.provider) === normalizeSurface(params.choice.providerId),
    )?.profileId;
    if (!nextProfileId) {
      return { text: formatProviderLoginCompletion(params.choice, loginResult.authRefresh, true) };
    }
    const switchResult = await switchLoginSessionProfile({
      commandParams: params.commandParams,
      loginProvider: params.choice.providerId,
      nextProfileId,
      signal: flowSignal,
      assertCurrent,
    });
    return {
      text: formatProviderLoginCompletion(
        params.choice,
        loginResult.authRefresh,
        switchResult === "failed",
      ),
    };
  } catch (error) {
    return {
      text: formatProviderLoginFailure(params.choice, error),
    };
  } finally {
    releaseProviderLoginFlow({
      flows: activeProviderLoginFlows,
      flowKey,
      record: reservation.record,
    });
  }
}

export const handleLoginCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const prepared = await prepareProviderChannelLogin({
    commandText: params.command.commandBodyNormalized,
    commandAuthorized: params.command.isAuthorizedSender,
    senderIsOwner: params.command.senderIsOwner,
    hasAdminScope: params.ctx.GatewayClientScopes?.includes("operator.admin"),
    isPrivateChat: isPrivateLoginContext(params),
    config: params.cfg,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    signal: params.opts?.abortSignal,
    cancelLogin: () =>
      cancelProviderLoginFlow({
        flows: activeProviderLoginFlows,
        flowKey: buildProviderLoginFlowKey(params),
      }),
  });
  if (!prepared) {
    return null;
  }
  if (prepared.status !== "ready") {
    return { shouldContinue: false, reply: prepared.reply };
  }
  const reply = await runChannelProviderLogin({
    commandParams: params,
    choice: prepared.choice,
    agentId: params.agentId,
  });
  return { shouldContinue: false, reply };
};

const commandsLoginTestApi = {
  clearActiveFlows() {
    activeProviderLoginFlows.clear();
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.commandsLoginTestApi")] =
    commandsLoginTestApi;
}
