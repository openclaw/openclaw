import type { GetReplyOptions as CoreGetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import type {
  ChannelTurnDeliveryAdapter,
  ChannelTurnResolved,
  RunChannelTurnParams,
} from "../channels/turn/types.js";
import {
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandReplyOptions,
} from "../plugins/plugin-command-dispatch-contract.js";

export type GetReplyOptions = CoreGetReplyOptions;

export type PublicReplyParams<T> = Omit<T, "replyOptions"> & {
  replyOptions?: Omit<GetReplyOptions, "onBlockReply" | "onPreparedBlockReply"> &
    PluginCommandReplyOptions;
};

type PublicChannelTurnResolved<T> = T extends unknown
  ? "replyOptions" extends keyof T
    ? PublicReplyParams<T>
    : T
  : never;

export type PublicChannelTurnParams<
  TRaw,
  TResult,
  TDelivery extends ChannelTurnDeliveryAdapter,
> = Omit<RunChannelTurnParams<TRaw, TResult, TDelivery>, "adapter"> & {
  adapter: Omit<RunChannelTurnParams<TRaw, TResult, TDelivery>["adapter"], "resolveTurn"> & {
    resolveTurn: (
      ...args: Parameters<RunChannelTurnParams<TRaw, TResult, TDelivery>["adapter"]["resolveTurn"]>
    ) =>
      | PublicChannelTurnResolved<ChannelTurnResolved<TResult, TDelivery>>
      | Promise<PublicChannelTurnResolved<ChannelTurnResolved<TResult, TDelivery>>>;
  };
};

type PrivateReplyOption = Exclude<
  keyof InternalGetReplyOptions,
  keyof CoreGetReplyOptions | keyof PluginCommandReplyOptions | symbol
>;

const privateReplyOptions = {
  scheduledAutomation: true,
  modelOverride: true,
  internalEventExecution: true,
  queuedFollowupAbortSignal: true,
  operatorAuthority: true,
  extractedFileImages: true,
  assertProviderLoginAuthority: true,
  getProviderLoginConfig: true,
  replyConversation: true,
  preparedTtsPreferences: true,
  prepareAssistantTranscriptMessage: true,
  mediaNormalizationOwner: true,
  admittedSessionSettings: true,
  cronCreatorAuthorityCapability: true,
  dashboardReadAdmission: true,
  expectedExistingSessionId: true,
  expectedActiveReplyOperation: true,
  newlyCreatedSessionId: true,
  onDeliberateSilentTerminalReply: true,
  resolveReplyDelivery: true,
  cleanupBundleMcpOnRunEnd: true,
  onPendingContinuation: true,
  onSessionPrepared: true,
  onReplyOperationOwned: true,
  onSessionMetadataChanges: true,
  onRunVerbosityResolved: true,
  pinExpectedExistingSession: true,
  requestedSessionId: true,
  resumeRequestedSession: true,
  sessionPromptSourceReplyDeliveryMode: true,
  onFollowupQueueDisposition: true,
  onQueuedFollowupReplyBatch: true,
  queueModeOverride: true,
  replyOperation: true,
  skillOverrides: true,
  skillWorkshopProposalRevision: true,
  skillLibraryAuthoring: true,
} satisfies Record<PrivateReplyOption, true>;

/** Public callbacks cannot supply private session or scheduler authority. */
export function publicReplyOptions(
  options: GetReplyOptions | undefined,
): CoreGetReplyOptions | undefined {
  if (!options) {
    return undefined;
  }
  const publicOptions: CoreGetReplyOptions = { ...options };
  for (const key of Object.keys(privateReplyOptions)) {
    Reflect.deleteProperty(publicOptions, key);
  }
  // Native command ownership is the only symbol carried by the public contract.
  // Do not import private admission/operation owners into the lazy SDK boundary.
  for (const key of Object.getOwnPropertySymbols(publicOptions)) {
    if (key !== PLUGIN_COMMAND_DISPATCH) {
      Reflect.deleteProperty(publicOptions, key);
    }
  }
  return publicOptions;
}

/** Scrub adapter-produced plans before core attaches its own authority. */
export function publicChannelTurn<T extends object>(
  turn: T & { replyOptions?: GetReplyOptions },
): Omit<T, "replyOptions"> & { replyOptions?: CoreGetReplyOptions } {
  return { ...turn, replyOptions: publicReplyOptions(turn.replyOptions) };
}

export function publicChannelTurnParams<
  TRaw,
  TResult,
  TDelivery extends ChannelTurnDeliveryAdapter,
>(
  params: PublicChannelTurnParams<TRaw, TResult, TDelivery>,
): RunChannelTurnParams<TRaw, TResult, TDelivery> {
  return {
    ...params,
    adapter: {
      ...params.adapter,
      resolveTurn: async (...args) => {
        const turn = await params.adapter.resolveTurn(...args);
        return {
          ...turn,
          replyOptions: publicReplyOptions("replyOptions" in turn ? turn.replyOptions : undefined),
        };
      },
    },
  };
}
