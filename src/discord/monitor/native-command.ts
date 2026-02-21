import {
  Button,
  ChannelType,
  Command,
  Container,
  Row,
  StringSelectMenu,
  TextDisplay,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type CommandInteraction,
  type CommandOptions,
  type ComponentData,
  type StringSelectMenuInteraction,
} from "@buape/carbon";
import { ApplicationCommandOptionType, ButtonStyle } from "discord-api-types/v10";
import { resolveHumanDelayConfig } from "../../agents/identity.js";
import { resolveChunkMode, resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import type {
  ChatCommandDefinition,
  CommandArgDefinition,
  CommandArgValues,
  CommandArgs,
  NativeCommandSpec,
} from "../../auto-reply/commands-registry.js";
import {
  buildCommandTextFromArgs,
  findCommandByNativeName,
  listChatCommands,
  parseCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
  serializeCommandArgs,
} from "../../auto-reply/commands-registry.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { resolveStoredModelOverride } from "../../auto-reply/reply/model-selection.js";
import { dispatchReplyWithDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import type { OpenClawConfig, loadConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { buildUntrustedChannelMetadata } from "../../security/channel-metadata.js";
import { chunkItems } from "../../utils/chunk-items.js";
import { withTimeout } from "../../utils/with-timeout.js";
import { loadWebMedia } from "../../web/media.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import {
  allowListMatches,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordOwnerAllowFrom,
} from "./allow-list.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";
import {
  readDiscordModelPickerRecentModels,
  recordDiscordModelPickerRecentModel,
  type DiscordModelPickerPreferenceScope,
} from "./model-picker-preferences.js";
import {
  DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
  loadDiscordModelPickerData,
  parseDiscordModelPickerData,
  renderDiscordModelPickerModelsView,
  renderDiscordModelPickerProvidersView,
  renderDiscordModelPickerRecentsView,
  toDiscordModelPickerMessagePayload,
  type DiscordModelPickerCommandContext,
} from "./model-picker.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";
import { resolveDiscordThreadParentInfo } from "./threading.js";

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];

function buildDiscordCommandOptions(params: {
  command: ChatCommandDefinition;
  cfg: ReturnType<typeof loadConfig>;
}): CommandOptions | undefined {
  const { command, cfg } = params;
  const args = command.args;
  if (!args || args.length === 0) {
    return undefined;
  }
  return args.map((arg) => {
    const required = arg.required ?? false;
    if (arg.type === "number") {
      return {
        name: arg.name,
        description: arg.description,
        type: ApplicationCommandOptionType.Number,
        required,
      };
    }
    if (arg.type === "boolean") {
      return {
        name: arg.name,
        description: arg.description,
        type: ApplicationCommandOptionType.Boolean,
        required,
      };
    }
    const resolvedChoices = resolveCommandArgChoices({ command, arg, cfg });
    const shouldAutocomplete =
      resolvedChoices.length > 0 &&
      (typeof arg.choices === "function" || resolvedChoices.length > 25);
    const autocomplete = shouldAutocomplete
      ? async (interaction: AutocompleteInteraction) => {
          const focused = interaction.options.getFocused();
          const focusValue =
            typeof focused?.value === "string" ? focused.value.trim().toLowerCase() : "";
          const choices = resolveCommandArgChoices({ command, arg, cfg });
          const filtered = focusValue
            ? choices.filter((choice) => choice.label.toLowerCase().includes(focusValue))
            : choices;
          await interaction.respond(
            filtered.slice(0, 25).map((choice) => ({ name: choice.label, value: choice.value })),
          );
        }
      : undefined;
    const choices =
      resolvedChoices.length > 0 && !autocomplete
        ? resolvedChoices
            .slice(0, 25)
            .map((choice) => ({ name: choice.label, value: choice.value }))
        : undefined;
    return {
      name: arg.name,
      description: arg.description,
      type: ApplicationCommandOptionType.String,
      required,
      choices,
      autocomplete,
    };
  }) satisfies CommandOptions;
}

function readDiscordCommandArgs(
  interaction: CommandInteraction,
  definitions?: CommandArgDefinition[],
): CommandArgs | undefined {
  if (!definitions || definitions.length === 0) {
    return undefined;
  }
  const values: CommandArgValues = {};
  for (const definition of definitions) {
    let value: string | number | boolean | null | undefined;
    if (definition.type === "number") {
      value = interaction.options.getNumber(definition.name) ?? null;
    } else if (definition.type === "boolean") {
      value = interaction.options.getBoolean(definition.name) ?? null;
    } else {
      value = interaction.options.getString(definition.name) ?? null;
    }
    if (value != null) {
      values[definition.name] = value;
    }
  }
  return Object.keys(values).length > 0 ? { values } : undefined;
}

const DISCORD_COMMAND_ARG_CUSTOM_ID_KEY = "cmdarg";

function createCommandArgsWithValue(params: { argName: string; value: string }): CommandArgs {
  const values: CommandArgValues = { [params.argName]: params.value };
  return { values };
}

function encodeDiscordCommandArgValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeDiscordCommandArgValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isDiscordUnknownInteraction(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const err = error as {
    discordCode?: number;
    status?: number;
    message?: string;
    rawBody?: { code?: number; message?: string };
  };
  if (err.discordCode === 10062 || err.rawBody?.code === 10062) {
    return true;
  }
  if (err.status === 404 && /Unknown interaction/i.test(err.message ?? "")) {
    return true;
  }
  if (/Unknown interaction/i.test(err.rawBody?.message ?? "")) {
    return true;
  }
  return false;
}

async function safeDiscordInteractionCall<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (isDiscordUnknownInteraction(error)) {
      logVerbose(`discord: ${label} skipped (interaction expired)`);
      return null;
    }
    throw error;
  }
}

function buildDiscordCommandArgCustomId(params: {
  command: string;
  arg: string;
  value: string;
  userId: string;
}): string {
  return [
    `${DISCORD_COMMAND_ARG_CUSTOM_ID_KEY}:command=${encodeDiscordCommandArgValue(params.command)}`,
    `arg=${encodeDiscordCommandArgValue(params.arg)}`,
    `value=${encodeDiscordCommandArgValue(params.value)}`,
    `user=${encodeDiscordCommandArgValue(params.userId)}`,
  ].join(";");
}

function parseDiscordCommandArgData(
  data: ComponentData,
): { command: string; arg: string; value: string; userId: string } | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const coerce = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const rawCommand = coerce(data.command);
  const rawArg = coerce(data.arg);
  const rawValue = coerce(data.value);
  const rawUser = coerce(data.user);
  if (!rawCommand || !rawArg || !rawValue || !rawUser) {
    return null;
  }
  return {
    command: decodeDiscordCommandArgValue(rawCommand),
    arg: decodeDiscordCommandArgValue(rawArg),
    value: decodeDiscordCommandArgValue(rawValue),
    userId: decodeDiscordCommandArgValue(rawUser),
  };
}

type DiscordCommandArgContext = {
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
};

type DiscordModelPickerContext = DiscordCommandArgContext;

function resolveDiscordModelPickerCommandContext(
  command: ChatCommandDefinition,
): DiscordModelPickerCommandContext | null {
  const normalized = (command.nativeName ?? command.key).trim().toLowerCase();
  if (normalized === "model" || normalized === "models") {
    return normalized;
  }
  return null;
}

function resolveCommandArgStringValue(args: CommandArgs | undefined, key: string): string {
  const value = args?.values?.[key];
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function shouldOpenDiscordModelPickerFromCommand(params: {
  command: ChatCommandDefinition;
  commandArgs?: CommandArgs;
}): DiscordModelPickerCommandContext | null {
  const context = resolveDiscordModelPickerCommandContext(params.command);
  if (!context) {
    return null;
  }

  const serializedArgs = serializeCommandArgs(params.command, params.commandArgs)?.trim() ?? "";
  if (context === "model") {
    const modelValue = resolveCommandArgStringValue(params.commandArgs, "model");
    return !modelValue && !serializedArgs ? context : null;
  }

  return serializedArgs ? null : context;
}

function buildDiscordModelPickerCurrentModel(
  defaultProvider: string,
  defaultModel: string,
): string {
  return `${defaultProvider}/${defaultModel}`;
}

function buildDiscordModelPickerAllowedModelRefs(
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>,
): Set<string> {
  const out = new Set<string>();
  for (const provider of data.providers) {
    const models = data.byProvider.get(provider);
    if (!models) {
      continue;
    }
    for (const model of models) {
      out.add(`${provider}/${model}`);
    }
  }
  return out;
}

function resolveDiscordModelPickerPreferenceScope(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  accountId: string;
  userId: string;
}): DiscordModelPickerPreferenceScope {
  return {
    accountId: params.accountId,
    guildId: params.interaction.guild?.id ?? undefined,
    userId: params.userId,
  };
}

function buildDiscordModelPickerNoticePayload(message: string): { components: Container[] } {
  return {
    components: [new Container([new TextDisplay(message)])],
  };
}

async function resolveDiscordModelPickerRoute(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  cfg: ReturnType<typeof loadConfig>;
  accountId: string;
}) {
  const { interaction, cfg, accountId } = params;
  const channel = interaction.channel;
  const channelType = channel?.type;
  const isDirectMessage = channelType === ChannelType.DM;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isThreadChannel =
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread;
  const rawChannelId = channel?.id ?? "unknown";
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => String(roleId))
    : [];
  let threadParentId: string | undefined;
  if (interaction.guild && channel && isThreadChannel && rawChannelId) {
    const channelInfo = await resolveDiscordChannelInfo(interaction.client, rawChannelId);
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: interaction.client,
      threadChannel: {
        id: rawChannelId,
        name: "name" in channel ? (channel.name as string | undefined) : undefined,
        parentId: "parentId" in channel ? (channel.parentId ?? undefined) : undefined,
        parent: undefined,
      },
      channelInfo,
    });
    threadParentId = parentInfo.id;
  }

  return resolveAgentRoute({
    cfg,
    channel: "discord",
    accountId,
    guildId: interaction.guild?.id ?? undefined,
    memberRoleIds,
    peer: {
      kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
      id: isDirectMessage ? (interaction.user?.id ?? rawChannelId) : rawChannelId,
    },
    parentPeer: threadParentId ? { kind: "channel", id: threadParentId } : undefined,
  });
}

function resolveDiscordModelPickerCurrentModel(params: {
  cfg: ReturnType<typeof loadConfig>;
  route: ReturnType<typeof resolveAgentRoute>;
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
}): string {
  const fallback = buildDiscordModelPickerCurrentModel(
    params.data.resolvedDefault.provider,
    params.data.resolvedDefault.model,
  );
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.route.agentId,
    });
    const sessionStore = loadSessionStore(storePath, { skipCache: true });
    const sessionEntry = sessionStore[params.route.sessionKey];
    const override = resolveStoredModelOverride({
      sessionEntry,
      sessionStore,
      sessionKey: params.route.sessionKey,
    });
    if (!override?.model) {
      return fallback;
    }
    const provider = (override.provider || params.data.resolvedDefault.provider).trim();
    if (!provider) {
      return fallback;
    }
    return `${provider}/${override.model}`;
  } catch {
    return fallback;
  }
}

async function replyWithDiscordModelPickerProviders(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  cfg: ReturnType<typeof loadConfig>;
  command: DiscordModelPickerCommandContext;
  userId: string;
  accountId: string;
  preferFollowUp: boolean;
}) {
  const data = await loadDiscordModelPickerData(params.cfg);
  const route = await resolveDiscordModelPickerRoute({
    interaction: params.interaction,
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const currentModel = resolveDiscordModelPickerCurrentModel({
    cfg: params.cfg,
    route,
    data,
  });
  const quickModels = await readDiscordModelPickerRecentModels({
    scope: resolveDiscordModelPickerPreferenceScope({
      interaction: params.interaction,
      accountId: params.accountId,
      userId: params.userId,
    }),
    allowedModelRefs: buildDiscordModelPickerAllowedModelRefs(data),
    limit: 5,
  });

  const rendered = renderDiscordModelPickerModelsView({
    command: params.command,
    userId: params.userId,
    data,
    provider: splitDiscordModelRef(currentModel ?? "")?.provider ?? data.resolvedDefault.provider,
    page: 1,
    providerPage: 1,
    currentModel,
    quickModels,
  });
  const payload = {
    ...toDiscordModelPickerMessagePayload(rendered),
    ephemeral: true,
  };

  await safeDiscordInteractionCall("model picker reply", async () => {
    if (params.preferFollowUp) {
      await params.interaction.followUp(payload);
      return;
    }
    await params.interaction.reply(payload);
  });
}

function resolveModelPickerSelectionValue(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): string | null {
  const rawValues = (interaction as { values?: string[] }).values;
  if (!Array.isArray(rawValues) || rawValues.length === 0) {
    return null;
  }
  const first = rawValues[0];
  if (typeof first !== "string") {
    return null;
  }
  const trimmed = first.trim();
  return trimmed || null;
}

function buildDiscordModelPickerSelectionCommand(params: {
  modelRef: string;
}): { command: ChatCommandDefinition; args: CommandArgs; prompt: string } | null {
  const commandDefinition =
    findCommandByNativeName("model", "discord") ??
    listChatCommands().find((entry) => entry.key === "model");
  if (!commandDefinition) {
    return null;
  }
  const commandArgs: CommandArgs = {
    values: {
      model: params.modelRef,
    },
    raw: params.modelRef,
  };
  return {
    command: commandDefinition,
    args: commandArgs,
    prompt: buildCommandTextFromArgs(commandDefinition, commandArgs),
  };
}

function listDiscordModelPickerProviderModels(
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>,
  provider: string,
): string[] {
  const modelSet = data.byProvider.get(provider);
  if (!modelSet) {
    return [];
  }
  return [...modelSet].toSorted();
}

function resolveDiscordModelPickerModelIndex(params: {
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  provider: string;
  model: string;
}): number | null {
  const models = listDiscordModelPickerProviderModels(params.data, params.provider);
  if (!models.length) {
    return null;
  }
  const index = models.indexOf(params.model);
  if (index < 0) {
    return null;
  }
  return index + 1;
}

function resolveDiscordModelPickerModelByIndex(params: {
  data: Awaited<ReturnType<typeof loadDiscordModelPickerData>>;
  provider: string;
  modelIndex?: number;
}): string | null {
  if (!params.modelIndex || params.modelIndex < 1) {
    return null;
  }
  const models = listDiscordModelPickerProviderModels(params.data, params.provider);
  if (!models.length) {
    return null;
  }
  return models[params.modelIndex - 1] ?? null;
}

function splitDiscordModelRef(modelRef: string): { provider: string; model: string } | null {
  const trimmed = modelRef.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return null;
  }
  const provider = trimmed.slice(0, slashIndex).trim();
  const model = trimmed.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

async function handleDiscordModelPickerInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  data: ComponentData,
  ctx: DiscordModelPickerContext,
) {
  const parsed = parseDiscordModelPickerData(data);
  if (!parsed) {
    await safeDiscordInteractionCall("model picker update", () =>
      interaction.update(
        buildDiscordModelPickerNoticePayload(
          "Sorry, that model picker interaction is no longer available.",
        ),
      ),
    );
    return;
  }

  if (interaction.user?.id && interaction.user.id !== parsed.userId) {
    await safeDiscordInteractionCall("model picker ack", () => interaction.acknowledge());
    return;
  }

  const pickerData = await loadDiscordModelPickerData(ctx.cfg);
  const route = await resolveDiscordModelPickerRoute({
    interaction,
    cfg: ctx.cfg,
    accountId: ctx.accountId,
  });
  const currentModelRef = resolveDiscordModelPickerCurrentModel({
    cfg: ctx.cfg,
    route,
    data: pickerData,
  });
  const allowedModelRefs = buildDiscordModelPickerAllowedModelRefs(pickerData);
  const preferenceScope = resolveDiscordModelPickerPreferenceScope({
    interaction,
    accountId: ctx.accountId,
    userId: parsed.userId,
  });
  const quickModels = await readDiscordModelPickerRecentModels({
    scope: preferenceScope,
    allowedModelRefs,
    limit: 5,
  });

  if (parsed.action === "recents") {
    const rendered = renderDiscordModelPickerRecentsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      quickModels,
      currentModel: currentModelRef,
      provider: parsed.provider,
      page: parsed.page,
      providerPage: parsed.providerPage,
    });

    await safeDiscordInteractionCall("model picker update", () =>
      interaction.update(toDiscordModelPickerMessagePayload(rendered)),
    );
    return;
  }

  if (parsed.action === "back" && parsed.view === "providers") {
    const rendered = renderDiscordModelPickerProvidersView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      page: parsed.page,
      currentModel: currentModelRef,
    });

    await safeDiscordInteractionCall("model picker update", () =>
      interaction.update(toDiscordModelPickerMessagePayload(rendered)),
    );
    return;
  }

  if (parsed.action === "back" && parsed.view === "models") {
    const provider =
      parsed.provider ??
      splitDiscordModelRef(currentModelRef ?? "")?.provider ??
      pickerData.resolvedDefault.provider;

    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: parsed.page ?? 1,
      providerPage: parsed.providerPage ?? 1,
      currentModel: currentModelRef,
      quickModels,
    });

    await safeDiscordInteractionCall("model picker update", () =>
      interaction.update(toDiscordModelPickerMessagePayload(rendered)),
    );
    return;
  }

  if (parsed.action === "provider") {
    const selectedProvider = resolveModelPickerSelectionValue(interaction) ?? parsed.provider;
    if (!selectedProvider || !pickerData.byProvider.has(selectedProvider)) {
      await safeDiscordInteractionCall("model picker update", () =>
        interaction.update(
          buildDiscordModelPickerNoticePayload("Sorry, that provider isn't available anymore."),
        ),
      );
      return;
    }

    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider: selectedProvider,
      page: 1,
      providerPage: parsed.providerPage ?? parsed.page,
      currentModel: currentModelRef,
      quickModels,
    });

    await safeDiscordInteractionCall("model picker update", () =>
      interaction.update(toDiscordModelPickerMessagePayload(rendered)),
    );
    return;
  }

  if (parsed.action === "model") {
    const selectedModel = resolveModelPickerSelectionValue(interaction);
    const provider = parsed.provider;
    if (!provider || !selectedModel) {
      await safeDiscordInteractionCall("model picker update", () =>
        interaction.update(
          buildDiscordModelPickerNoticePayload("Sorry, I couldn't read that model selection."),
        ),
      );
      return;
    }

    const modelIndex = resolveDiscordModelPickerModelIndex({
      data: pickerData,
      provider,
      model: selectedModel,
    });
    if (!modelIndex) {
      await safeDiscordInteractionCall("model picker update", () =>
        interaction.update(
          buildDiscordModelPickerNoticePayload("Sorry, that model isn't available anymore."),
        ),
      );
      return;
    }

    const modelRef = `${provider}/${selectedModel}`;
    const rendered = renderDiscordModelPickerModelsView({
      command: parsed.command,
      userId: parsed.userId,
      data: pickerData,
      provider,
      page: parsed.page,
      providerPage: parsed.providerPage ?? 1,
      currentModel: currentModelRef,
      pendingModel: modelRef,
      pendingModelIndex: modelIndex,
      quickModels,
    });

    await safeDiscordInteractionCall("model picker update", () =>
      interaction.update(toDiscordModelPickerMessagePayload(rendered)),
    );
    return;
  }

  if (parsed.action === "submit" || parsed.action === "reset" || parsed.action === "quick") {
    let modelRef: string | null = null;

    if (parsed.action === "reset") {
      modelRef = `${pickerData.resolvedDefault.provider}/${pickerData.resolvedDefault.model}`;
    } else if (parsed.action === "quick") {
      const slot = parsed.recentSlot ?? 0;
      modelRef = slot >= 1 ? (quickModels[slot - 1] ?? null) : null;
    } else if (parsed.view === "recents") {
      const defaultModelRef = `${pickerData.resolvedDefault.provider}/${pickerData.resolvedDefault.model}`;
      const dedupedRecents = quickModels.filter((ref) => ref !== defaultModelRef);
      const slot = parsed.recentSlot ?? 0;
      if (slot === 1) {
        modelRef = defaultModelRef;
      } else if (slot >= 2) {
        modelRef = dedupedRecents[slot - 2] ?? null;
      }
    } else {
      const provider = parsed.provider;
      const selectedModel = resolveDiscordModelPickerModelByIndex({
        data: pickerData,
        provider: provider ?? "",
        modelIndex: parsed.modelIndex,
      });
      modelRef = provider && selectedModel ? `${provider}/${selectedModel}` : null;
    }
    const parsedModelRef = modelRef ? splitDiscordModelRef(modelRef) : null;
    if (
      !parsedModelRef ||
      !pickerData.byProvider.get(parsedModelRef.provider)?.has(parsedModelRef.model)
    ) {
      await safeDiscordInteractionCall("model picker update", () =>
        interaction.update(
          buildDiscordModelPickerNoticePayload(
            "That selection expired. Please choose a model again.",
          ),
        ),
      );
      return;
    }

    const resolvedModelRef = `${parsedModelRef.provider}/${parsedModelRef.model}`;

    const selectionCommand = buildDiscordModelPickerSelectionCommand({
      modelRef: resolvedModelRef,
    });
    if (!selectionCommand) {
      await safeDiscordInteractionCall("model picker update", () =>
        interaction.update(
          buildDiscordModelPickerNoticePayload("Sorry, /model is unavailable right now."),
        ),
      );
      return;
    }

    const updateResult = await safeDiscordInteractionCall("model picker update", () =>
      interaction.update(
        buildDiscordModelPickerNoticePayload(`Applying model change to ${resolvedModelRef}...`),
      ),
    );
    if (updateResult === null) {
      return;
    }

    try {
      await withTimeout(
        dispatchDiscordCommandInteraction({
          interaction,
          prompt: selectionCommand.prompt,
          command: selectionCommand.command,
          commandArgs: selectionCommand.args,
          cfg: ctx.cfg,
          discordConfig: ctx.discordConfig,
          accountId: ctx.accountId,
          sessionPrefix: ctx.sessionPrefix,
          preferFollowUp: true,
          suppressReplies: true,
        }),
        12000,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "timeout") {
        await safeDiscordInteractionCall("model picker follow-up", () =>
          interaction.followUp({
            ...buildDiscordModelPickerNoticePayload(
              `⏳ Model change to ${resolvedModelRef} is still processing. Check /status in a few seconds.`,
            ),
            ephemeral: true,
          }),
        );
        return;
      }

      await safeDiscordInteractionCall("model picker follow-up", () =>
        interaction.followUp({
          ...buildDiscordModelPickerNoticePayload(
            `❌ Failed to apply ${resolvedModelRef}. Try /model ${resolvedModelRef} directly.`,
          ),
          ephemeral: true,
        }),
      );
      return;
    }

    const effectiveModelRef = resolveDiscordModelPickerCurrentModel({
      cfg: ctx.cfg,
      route,
      data: pickerData,
    });
    const persisted = effectiveModelRef === resolvedModelRef;

    if (!persisted) {
      logVerbose(
        `discord: model picker override mismatch — expected ${resolvedModelRef} but read ${effectiveModelRef} from session key ${route.sessionKey}`,
      );
    }

    if (persisted) {
      await recordDiscordModelPickerRecentModel({
        scope: preferenceScope,
        modelRef: resolvedModelRef,
        limit: 5,
      }).catch(() => undefined);
    }

    await safeDiscordInteractionCall("model picker follow-up", () =>
      interaction.followUp({
        ...buildDiscordModelPickerNoticePayload(
          persisted
            ? `✅ Model set to ${resolvedModelRef}.`
            : `⚠️ Tried to set ${resolvedModelRef}, but current model is ${effectiveModelRef}.`,
        ),
        ephemeral: true,
      }),
    );
    return;
  }

  if (parsed.action === "cancel") {
    const displayModel = currentModelRef ?? "default";
    await safeDiscordInteractionCall("model picker update", () =>
      interaction.update(buildDiscordModelPickerNoticePayload(`ℹ️ Model kept as ${displayModel}.`)),
    );
    return;
  }
}

async function handleDiscordCommandArgInteraction(
  interaction: ButtonInteraction,
  data: ComponentData,
  ctx: DiscordCommandArgContext,
) {
  const parsed = parseDiscordCommandArgData(data);
  if (!parsed) {
    await safeDiscordInteractionCall("command arg update", () =>
      interaction.update({
        content: "Sorry, that selection is no longer available.",
        components: [],
      }),
    );
    return;
  }
  if (interaction.user?.id && interaction.user.id !== parsed.userId) {
    await safeDiscordInteractionCall("command arg ack", () => interaction.acknowledge());
    return;
  }
  const commandDefinition =
    findCommandByNativeName(parsed.command, "discord") ??
    listChatCommands().find((entry) => entry.key === parsed.command);
  if (!commandDefinition) {
    await safeDiscordInteractionCall("command arg update", () =>
      interaction.update({
        content: "Sorry, that command is no longer available.",
        components: [],
      }),
    );
    return;
  }
  const argUpdateResult = await safeDiscordInteractionCall("command arg update", () =>
    interaction.update({
      content: `✅ Selected ${parsed.value}.`,
      components: [],
    }),
  );
  if (argUpdateResult === null) {
    return;
  }
  const commandArgs = createCommandArgsWithValue({
    argName: parsed.arg,
    value: parsed.value,
  });
  const commandArgsWithRaw: CommandArgs = {
    ...commandArgs,
    raw: serializeCommandArgs(commandDefinition, commandArgs),
  };
  const prompt = buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw);
  await dispatchDiscordCommandInteraction({
    interaction,
    prompt,
    command: commandDefinition,
    commandArgs: commandArgsWithRaw,
    cfg: ctx.cfg,
    discordConfig: ctx.discordConfig,
    accountId: ctx.accountId,
    sessionPrefix: ctx.sessionPrefix,
    preferFollowUp: true,
  });
}

class DiscordCommandArgButton extends Button {
  label: string;
  customId: string;
  style = ButtonStyle.Secondary;
  private cfg: ReturnType<typeof loadConfig>;
  private discordConfig: DiscordConfig;
  private accountId: string;
  private sessionPrefix: string;

  constructor(params: {
    label: string;
    customId: string;
    cfg: ReturnType<typeof loadConfig>;
    discordConfig: DiscordConfig;
    accountId: string;
    sessionPrefix: string;
  }) {
    super();
    this.label = params.label;
    this.customId = params.customId;
    this.cfg = params.cfg;
    this.discordConfig = params.discordConfig;
    this.accountId = params.accountId;
    this.sessionPrefix = params.sessionPrefix;
  }

  async run(interaction: ButtonInteraction, data: ComponentData) {
    await handleDiscordCommandArgInteraction(interaction, data, {
      cfg: this.cfg,
      discordConfig: this.discordConfig,
      accountId: this.accountId,
      sessionPrefix: this.sessionPrefix,
    });
  }
}

class DiscordCommandArgFallbackButton extends Button {
  label = "cmdarg";
  customId = "cmdarg:seed=1";
  private ctx: DiscordCommandArgContext;

  constructor(ctx: DiscordCommandArgContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData) {
    await handleDiscordCommandArgInteraction(interaction, data, this.ctx);
  }
}

export function createDiscordCommandArgFallbackButton(params: DiscordCommandArgContext): Button {
  return new DiscordCommandArgFallbackButton(params);
}

class DiscordModelPickerFallbackButton extends Button {
  label = DISCORD_MODEL_PICKER_CUSTOM_ID_KEY;
  customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=btn`;
  private ctx: DiscordModelPickerContext;

  constructor(ctx: DiscordModelPickerContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData) {
    await handleDiscordModelPickerInteraction(interaction, data, this.ctx);
  }
}

class DiscordModelPickerFallbackSelect extends StringSelectMenu {
  customId = `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:seed=sel`;
  options = [];
  private ctx: DiscordModelPickerContext;

  constructor(ctx: DiscordModelPickerContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: StringSelectMenuInteraction, data: ComponentData) {
    await handleDiscordModelPickerInteraction(interaction, data, this.ctx);
  }
}

export function createDiscordModelPickerFallbackButton(params: DiscordModelPickerContext): Button {
  return new DiscordModelPickerFallbackButton(params);
}

export function createDiscordModelPickerFallbackSelect(
  params: DiscordModelPickerContext,
): StringSelectMenu {
  return new DiscordModelPickerFallbackSelect(params);
}

function buildDiscordCommandArgMenu(params: {
  command: ChatCommandDefinition;
  menu: {
    arg: CommandArgDefinition;
    choices: Array<{ value: string; label: string }>;
    title?: string;
  };
  interaction: CommandInteraction;
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
}): { content: string; components: Row<Button>[] } {
  const { command, menu, interaction } = params;
  const commandLabel = command.nativeName ?? command.key;
  const userId = interaction.user?.id ?? "";
  const rows = chunkItems(menu.choices, 4).map((choices) => {
    const buttons = choices.map(
      (choice) =>
        new DiscordCommandArgButton({
          label: choice.label,
          customId: buildDiscordCommandArgCustomId({
            command: commandLabel,
            arg: menu.arg.name,
            value: choice.value,
            userId,
          }),
          cfg: params.cfg,
          discordConfig: params.discordConfig,
          accountId: params.accountId,
          sessionPrefix: params.sessionPrefix,
        }),
    );
    return new Row(buttons);
  });
  const content =
    menu.title ?? `Choose ${menu.arg.description || menu.arg.name} for /${commandLabel}.`;
  return { content, components: rows };
}

export function createDiscordNativeCommand(params: {
  command: NativeCommandSpec;
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  ephemeralDefault: boolean;
}): Command {
  const { command, cfg, discordConfig, accountId, sessionPrefix, ephemeralDefault } = params;
  const commandDefinition =
    findCommandByNativeName(command.name, "discord") ??
    ({
      key: command.name,
      nativeName: command.name,
      description: command.description,
      textAliases: [],
      acceptsArgs: command.acceptsArgs,
      args: command.args,
      argsParsing: "none",
      scope: "native",
    } satisfies ChatCommandDefinition);
  const argDefinitions = commandDefinition.args ?? command.args;
  const commandOptions = buildDiscordCommandOptions({
    command: commandDefinition,
    cfg,
  });
  const options = commandOptions
    ? (commandOptions satisfies CommandOptions)
    : command.acceptsArgs
      ? ([
          {
            name: "input",
            description: "Command input",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ] satisfies CommandOptions)
      : undefined;

  return new (class extends Command {
    name = command.name;
    description = command.description;
    defer = true;
    ephemeral = ephemeralDefault;
    options = options;

    async run(interaction: CommandInteraction) {
      const commandArgs = argDefinitions?.length
        ? readDiscordCommandArgs(interaction, argDefinitions)
        : command.acceptsArgs
          ? parseCommandArgs(commandDefinition, interaction.options.getString("input") ?? "")
          : undefined;
      const commandArgsWithRaw = commandArgs
        ? ({
            ...commandArgs,
            raw: serializeCommandArgs(commandDefinition, commandArgs) ?? commandArgs.raw,
          } satisfies CommandArgs)
        : undefined;
      const prompt = buildCommandTextFromArgs(commandDefinition, commandArgsWithRaw);
      await dispatchDiscordCommandInteraction({
        interaction,
        prompt,
        command: commandDefinition,
        commandArgs: commandArgsWithRaw,
        cfg,
        discordConfig,
        accountId,
        sessionPrefix,
        preferFollowUp: false,
      });
    }
  })();
}

async function dispatchDiscordCommandInteraction(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  prompt: string;
  command: ChatCommandDefinition;
  commandArgs?: CommandArgs;
  cfg: ReturnType<typeof loadConfig>;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  preferFollowUp: boolean;
  suppressReplies?: boolean;
}) {
  const {
    interaction,
    prompt,
    command,
    commandArgs,
    cfg,
    discordConfig,
    accountId,
    sessionPrefix,
    preferFollowUp,
    suppressReplies,
  } = params;
  const respond = async (content: string, options?: { ephemeral?: boolean }) => {
    const payload = {
      content,
      ...(options?.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
    };
    await safeDiscordInteractionCall("interaction reply", async () => {
      if (preferFollowUp) {
        await interaction.followUp(payload);
        return;
      }
      await interaction.reply(payload);
    });
  };

  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const user = interaction.user;
  if (!user) {
    return;
  }
  const sender = resolveDiscordSenderIdentity({ author: user, pluralkitInfo: null });
  const channel = interaction.channel;
  const channelType = channel?.type;
  const isDirectMessage = channelType === ChannelType.DM;
  const isGroupDm = channelType === ChannelType.GroupDM;
  const isThreadChannel =
    channelType === ChannelType.PublicThread ||
    channelType === ChannelType.PrivateThread ||
    channelType === ChannelType.AnnouncementThread;
  const channelName = channel && "name" in channel ? (channel.name as string) : undefined;
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const rawChannelId = channel?.id ?? "";
  const memberRoleIds = Array.isArray(interaction.rawData.member?.roles)
    ? interaction.rawData.member.roles.map((roleId: string) => String(roleId))
    : [];
  const ownerAllowList = normalizeDiscordAllowList(
    discordConfig?.allowFrom ?? discordConfig?.dm?.allowFrom ?? [],
    ["discord:", "user:", "pk:"],
  );
  const ownerOk =
    ownerAllowList && user
      ? allowListMatches(ownerAllowList, {
          id: sender.id,
          name: sender.name,
          tag: sender.tag,
        })
      : false;
  const guildInfo = resolveDiscordGuildEntry({
    guild: interaction.guild ?? undefined,
    guildEntries: discordConfig?.guilds,
  });
  let threadParentId: string | undefined;
  let threadParentName: string | undefined;
  let threadParentSlug = "";
  if (interaction.guild && channel && isThreadChannel && rawChannelId) {
    // Threads inherit parent channel config unless explicitly overridden.
    const channelInfo = await resolveDiscordChannelInfo(interaction.client, rawChannelId);
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: interaction.client,
      threadChannel: {
        id: rawChannelId,
        name: channelName,
        parentId: "parentId" in channel ? (channel.parentId ?? undefined) : undefined,
        parent: undefined,
      },
      channelInfo,
    });
    threadParentId = parentInfo.id;
    threadParentName = parentInfo.name;
    threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  }
  const channelConfig = interaction.guild
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: rawChannelId,
        channelName,
        channelSlug,
        parentId: threadParentId,
        parentName: threadParentName,
        parentSlug: threadParentSlug,
        scope: isThreadChannel ? "thread" : "channel",
      })
    : null;
  if (channelConfig?.enabled === false) {
    await respond("This channel is disabled.");
    return;
  }
  if (interaction.guild && channelConfig?.allowed === false) {
    await respond("This channel is not allowed.");
    return;
  }
  if (useAccessGroups && interaction.guild) {
    const channelAllowlistConfigured =
      Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
    const channelAllowed = channelConfig?.allowed !== false;
    const allowByPolicy = isDiscordGroupAllowedByPolicy({
      groupPolicy: discordConfig?.groupPolicy ?? "open",
      guildAllowlisted: Boolean(guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    });
    if (!allowByPolicy) {
      await respond("This channel is not allowed.");
      return;
    }
  }
  const dmEnabled = discordConfig?.dm?.enabled ?? true;
  const dmPolicy = discordConfig?.dmPolicy ?? discordConfig?.dm?.policy ?? "pairing";
  let commandAuthorized = true;
  if (isDirectMessage) {
    if (!dmEnabled || dmPolicy === "disabled") {
      await respond("Discord DMs are disabled.");
      return;
    }
    if (dmPolicy !== "open") {
      const storeAllowFrom = await readChannelAllowFromStore("discord").catch(() => []);
      const effectiveAllowFrom = [
        ...(discordConfig?.allowFrom ?? discordConfig?.dm?.allowFrom ?? []),
        ...storeAllowFrom,
      ];
      const allowList = normalizeDiscordAllowList(effectiveAllowFrom, ["discord:", "user:", "pk:"]);
      const permitted = allowList
        ? allowListMatches(allowList, {
            id: sender.id,
            name: sender.name,
            tag: sender.tag,
          })
        : false;
      if (!permitted) {
        commandAuthorized = false;
        if (dmPolicy === "pairing") {
          const { code, created } = await upsertChannelPairingRequest({
            channel: "discord",
            id: user.id,
            meta: {
              tag: sender.tag,
              name: sender.name,
            },
          });
          if (created) {
            await respond(
              buildPairingReply({
                channel: "discord",
                idLine: `Your Discord user id: ${user.id}`,
                code,
              }),
              { ephemeral: true },
            );
          }
        } else {
          await respond("You are not authorized to use this command.", { ephemeral: true });
        }
        return;
      }
      commandAuthorized = true;
    }
  }
  if (!isDirectMessage) {
    const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
      channelConfig,
      guildInfo,
      memberRoleIds,
      sender,
    });
    const authorizers = useAccessGroups
      ? [
          { configured: ownerAllowList != null, allowed: ownerOk },
          { configured: hasAccessRestrictions, allowed: memberAllowed },
        ]
      : [{ configured: hasAccessRestrictions, allowed: memberAllowed }];
    commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
      useAccessGroups,
      authorizers,
      modeWhenAccessGroupsOff: "configured",
    });
    if (!commandAuthorized) {
      await respond("You are not authorized to use this command.", { ephemeral: true });
      return;
    }
  }
  if (isGroupDm && discordConfig?.dm?.groupEnabled === false) {
    await respond("Discord group DMs are disabled.");
    return;
  }

  const menu = resolveCommandArgMenu({
    command,
    args: commandArgs,
    cfg,
  });
  if (menu) {
    const menuPayload = buildDiscordCommandArgMenu({
      command,
      menu,
      interaction: interaction as CommandInteraction,
      cfg,
      discordConfig,
      accountId,
      sessionPrefix,
    });
    if (preferFollowUp) {
      await safeDiscordInteractionCall("interaction follow-up", () =>
        interaction.followUp({
          content: menuPayload.content,
          components: menuPayload.components,
          ephemeral: true,
        }),
      );
      return;
    }
    await safeDiscordInteractionCall("interaction reply", () =>
      interaction.reply({
        content: menuPayload.content,
        components: menuPayload.components,
        ephemeral: true,
      }),
    );
    return;
  }

  const pickerCommandContext = shouldOpenDiscordModelPickerFromCommand({
    command,
    commandArgs,
  });
  if (pickerCommandContext) {
    await replyWithDiscordModelPickerProviders({
      interaction,
      cfg,
      command: pickerCommandContext,
      userId: user.id,
      accountId,
      preferFollowUp,
    });
    return;
  }

  const isGuild = Boolean(interaction.guild);
  const channelId = rawChannelId || "unknown";
  const interactionId = interaction.rawData.id;
  const route = resolveAgentRoute({
    cfg,
    channel: "discord",
    accountId,
    guildId: interaction.guild?.id ?? undefined,
    memberRoleIds,
    peer: {
      kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
      id: isDirectMessage ? user.id : channelId,
    },
    parentPeer: threadParentId ? { kind: "channel", id: threadParentId } : undefined,
  });
  const conversationLabel = isDirectMessage ? (user.globalName ?? user.username) : channelId;
  const ownerAllowFrom = resolveDiscordOwnerAllowFrom({
    channelConfig,
    guildInfo,
    sender: { id: sender.id, name: sender.name, tag: sender.tag },
  });
  const ctxPayload = finalizeInboundContext({
    Body: prompt,
    BodyForAgent: prompt,
    RawBody: prompt,
    CommandBody: prompt,
    CommandArgs: commandArgs,
    From: isDirectMessage
      ? `discord:${user.id}`
      : isGroupDm
        ? `discord:group:${channelId}`
        : `discord:channel:${channelId}`,
    To: `slash:${user.id}`,
    SessionKey: `agent:${route.agentId}:${sessionPrefix}:${user.id}`,
    CommandTargetSessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
    ConversationLabel: conversationLabel,
    GroupSubject: isGuild ? interaction.guild?.name : undefined,
    GroupSystemPrompt: isGuild
      ? (() => {
          const systemPromptParts = [channelConfig?.systemPrompt?.trim() || null].filter(
            (entry): entry is string => Boolean(entry),
          );
          return systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
        })()
      : undefined,
    UntrustedContext: isGuild
      ? (() => {
          const channelTopic =
            channel && "topic" in channel ? (channel.topic ?? undefined) : undefined;
          const untrustedChannelMetadata = buildUntrustedChannelMetadata({
            source: "discord",
            label: "Discord channel topic",
            entries: [channelTopic],
          });
          return untrustedChannelMetadata ? [untrustedChannelMetadata] : undefined;
        })()
      : undefined,
    OwnerAllowFrom: ownerAllowFrom,
    SenderName: user.globalName ?? user.username,
    SenderId: user.id,
    SenderUsername: user.username,
    SenderTag: sender.tag,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: true,
    MessageSid: interactionId,
    Timestamp: Date.now(),
    CommandAuthorized: commandAuthorized,
    CommandSource: "native" as const,
    // Native slash contexts use To=slash:<user> for interaction routing.
    // For follow-up delivery (for example subagent completion announces),
    // preserve the real Discord target separately.
    OriginatingChannel: "discord" as const,
    OriginatingTo: isDirectMessage ? `user:${user.id}` : `channel:${channelId}`,
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "discord",
    accountId: route.accountId,
  });
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);

  let didReply = false;
  await dispatchReplyWithDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload) => {
        if (suppressReplies) {
          return;
        }
        try {
          await deliverDiscordInteractionReply({
            interaction,
            payload,
            mediaLocalRoots,
            textLimit: resolveTextChunkLimit(cfg, "discord", accountId, {
              fallbackLimit: 2000,
            }),
            maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
            preferFollowUp: preferFollowUp || didReply,
            chunkMode: resolveChunkMode(cfg, "discord", accountId),
          });
        } catch (error) {
          if (isDiscordUnknownInteraction(error)) {
            logVerbose("discord: interaction reply skipped (interaction expired)");
            return;
          }
          throw error;
        }
        didReply = true;
      },
      onError: (err, info) => {
        console.error(`discord slash ${info.kind} reply failed`, err);
      },
    },
    replyOptions: {
      skillFilter: channelConfig?.skills,
      disableBlockStreaming:
        typeof discordConfig?.blockStreaming === "boolean"
          ? !discordConfig.blockStreaming
          : undefined,
      onModelSelected,
    },
  });
}

async function deliverDiscordInteractionReply(params: {
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  payload: ReplyPayload;
  mediaLocalRoots?: readonly string[];
  textLimit: number;
  maxLinesPerMessage?: number;
  preferFollowUp: boolean;
  chunkMode: "length" | "newline";
}) {
  const { interaction, payload, textLimit, maxLinesPerMessage, preferFollowUp, chunkMode } = params;
  const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
  const text = payload.text ?? "";

  let hasReplied = false;
  const sendMessage = async (content: string, files?: { name: string; data: Buffer }[]) => {
    const payload =
      files && files.length > 0
        ? {
            content,
            files: files.map((file) => {
              if (file.data instanceof Blob) {
                return { name: file.name, data: file.data };
              }
              const arrayBuffer = Uint8Array.from(file.data).buffer;
              return { name: file.name, data: new Blob([arrayBuffer]) };
            }),
          }
        : { content };
    await safeDiscordInteractionCall("interaction send", async () => {
      if (!preferFollowUp && !hasReplied) {
        await interaction.reply(payload);
        hasReplied = true;
        return;
      }
      await interaction.followUp(payload);
      hasReplied = true;
    });
  };

  if (mediaList.length > 0) {
    const media = await Promise.all(
      mediaList.map(async (url) => {
        const loaded = await loadWebMedia(url, {
          localRoots: params.mediaLocalRoots,
        });
        return {
          name: loaded.fileName ?? "upload",
          data: loaded.buffer,
        };
      }),
    );
    const chunks = chunkDiscordTextWithMode(text, {
      maxChars: textLimit,
      maxLines: maxLinesPerMessage,
      chunkMode,
    });
    if (!chunks.length && text) {
      chunks.push(text);
    }
    const caption = chunks[0] ?? "";
    await sendMessage(caption, media);
    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) {
        continue;
      }
      await interaction.followUp({ content: chunk });
    }
    return;
  }

  if (!text.trim()) {
    return;
  }
  const chunks = chunkDiscordTextWithMode(text, {
    maxChars: textLimit,
    maxLines: maxLinesPerMessage,
    chunkMode,
  });
  if (!chunks.length && text) {
    chunks.push(text);
  }
  for (const chunk of chunks) {
    if (!chunk.trim()) {
      continue;
    }
    await sendMessage(chunk);
  }
}
