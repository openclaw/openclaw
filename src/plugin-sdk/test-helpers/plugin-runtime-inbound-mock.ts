import { vi } from "vitest";
import { normalizeInboundTextNewlines } from "../../auto-reply/reply/inbound-text.js";
import {
  createChannelIngressPolicyResolver,
  resolveChannelIngressPolicy,
  resolveStableChannelIngressPolicy,
} from "../../channels/message-access/runtime.js";
import { createChannelReplyPipeline } from "../../channels/message/reply-pipeline.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createGenericMock } from "./plugin-runtime-generic-mock.js";

type Inbound = PluginRuntime["channel"]["inbound"];
type BuildContextParams = Parameters<Inbound["buildContext"]>[0];
type BuildContextResult = ReturnType<Inbound["buildContext"]>;
type ChannelStructuredContextEntries = NonNullable<
  Awaited<BuildContextResult>["ChannelStructuredContext"]
>;
function resolveMockChannelStructuredContext(
  params: Pick<BuildContextParams, "extra" | "supplemental">,
): ChannelStructuredContextEntries | undefined {
  const entries: ChannelStructuredContextEntries = [];
  const extraEntries =
    params.extra?.ChannelStructuredContext ?? params.extra?.UntrustedStructuredContext;
  if (Array.isArray(extraEntries)) {
    entries.push(...(extraEntries as ChannelStructuredContextEntries));
  }
  const supplementalEntries =
    params.supplemental?.channelStructuredContext ?? params.supplemental?.untrustedContext;
  if (supplementalEntries !== undefined) {
    entries.push(...supplementalEntries);
  }

  const prompt = params.supplemental?.untrustedGroupSystemPrompt;
  const normalized = typeof prompt === "string" ? normalizeInboundTextNewlines(prompt) : undefined;
  const groupPrompt = normalized?.trim() ? normalized : undefined;
  if (groupPrompt) {
    entries.push({
      label: "Group prompt context",
      type: "group_prompt_context",
      payload: { text: groupPrompt },
    });
  }

  const contextProvided =
    extraEntries !== undefined || supplementalEntries !== undefined || groupPrompt !== undefined;
  return contextProvided ? entries : undefined;
}

async function recordSession(
  params: Pick<
    Parameters<Inbound["runPreparedReply"]>[0],
    "recordInboundSession" | "storePath" | "ctxPayload" | "record" | "afterRecord"
  >,
  sessionKey: string,
) {
  const { record, storePath, ctxPayload: ctx, recordInboundSession } = params;
  await recordInboundSession({
    storePath,
    sessionKey,
    ctx,
    groupResolution: record?.groupResolution,
    createIfMissing: record?.createIfMissing,
    updateLastRoute: record?.updateLastRoute,
    onRecordError: record?.onRecordError ?? (() => undefined),
    trackSessionMetaTask: record?.trackSessionMetaTask,
  });
  await params.afterRecord?.();
}

export function createPluginInboundRuntimeMock(
  getRuntime: () => PluginRuntime | undefined,
): Inbound {
  const dispatchAssembledChannelTurnMock = vi.fn<Inbound["dispatchReply"]>(async (params) => {
    const admission = params.admission ?? { kind: "dispatch" as const };
    const { ctxPayload, routeSessionKey, dispatchReplyWithBufferedBlockDispatcher } = params;
    const sourceDelivery = params.delivery as typeof params.delivery & {
      deliverWithProviderMessageSending?: typeof params.delivery.deliver;
    };
    const sourceDeliver =
      sourceDelivery.deliverWithProviderMessageSending ?? sourceDelivery.deliver;
    if (admission.kind !== "observeOnly" && !sourceDeliver) {
      throw new Error("channel delivery mock requires a delivery callback");
    }
    const delivery =
      admission.kind === "observeOnly"
        ? { ...sourceDelivery, deliver: async () => ({ visibleReplySent: false }) }
        : { ...sourceDelivery, deliver: sourceDeliver! };
    const ctxSessionKey = ctxPayload.SessionKey;
    const sessionKey = typeof ctxSessionKey === "string" ? ctxSessionKey : routeSessionKey;
    const pipeline = params.replyPipeline
      ? createChannelReplyPipeline({
          ...(params.replyPipeline as Omit<
            Parameters<typeof createChannelReplyPipeline>[0],
            "cfg" | "agentId" | "channel" | "accountId"
          >),
          cfg: params.cfg,
          agentId: params.agentId,
          channel: params.channel,
          accountId: params.accountId,
        })
      : undefined;
    const { onModelSelected, ...dispatcherPipeline } = pipeline ?? {};
    await recordSession(params, sessionKey);
    const rawDispatchResult = await dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: params.cfg,
      dispatcherOptions: {
        ...dispatcherPipeline,
        ...params.dispatcherOptions,
        deliver: async (payload, info) => {
          const result = await delivery.deliver(payload, info);
          await delivery.onDelivered?.(payload, info, result);
          return result;
        },
        onError: delivery.onError,
      },
      replyOptions: {
        ...(onModelSelected ? { onModelSelected } : {}),
        ...params.replyOptions,
        ...(params.turnAdoptionLifecycle
          ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
          : {}),
      },
      replyResolver: params.replyResolver,
    });
    const dispatchResult =
      admission.kind === "observeOnly"
        ? { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }
        : rawDispatchResult;
    return {
      admission,
      dispatched: true,
      ctxPayload,
      routeSessionKey,
      dispatchResult,
    };
  });
  const runPreparedChannelTurnMock = createGenericMock<Inbound["runPreparedReply"]>(
    async (params: Parameters<Inbound["runPreparedReply"]>[0]) => {
      try {
        await recordSession(params, params.ctxPayload.SessionKey ?? params.routeSessionKey);
      } catch (err) {
        try {
          await params.onPreDispatchFailure?.(err);
        } catch {
          // Preserve the original session-recording error.
        }
        throw err;
      }
      const admission = params.admission ?? { kind: "dispatch" as const };
      let dispatchResult;
      if (admission.kind === "observeOnly") {
        await params.runDispatchLifecycle?.onDispatchSkipped("observeOnly");
        dispatchResult = params.observeOnlyDispatchResult ?? {
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        };
      } else {
        dispatchResult = await params.runDispatch();
      }
      return {
        admission,
        dispatched: true,
        ctxPayload: params.ctxPayload,
        routeSessionKey: params.routeSessionKey,
        dispatchResult,
      };
    },
  );
  const dispatchChannelTurnPlanMock = createGenericMock<Inbound["dispatch"]>(
    async (params: Parameters<Inbound["dispatch"]>[0]) => {
      const mergedRuntime = getRuntime();
      if (!mergedRuntime) {
        throw new Error("plugin runtime mock dispatch used before initialization");
      }
      return await dispatchAssembledChannelTurnMock({
        ...params,
        agentId: params.route.agentId,
        routeSessionKey: params.route.sessionKey,
        storePath: mergedRuntime.channel.session.resolveStorePath(params.cfg.session?.store, {
          agentId: params.route.agentId,
        }),
        recordInboundSession: mergedRuntime.channel.session.recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher:
          mergedRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      });
    },
  );
  const runChannelTurnMock = createGenericMock<Inbound["run"]>(
    async (params: Parameters<Inbound["run"]>[0]) => {
      const input = await params.adapter.ingest(params.raw);
      if (!input) {
        return {
          admission: { kind: "drop" as const, reason: "ingest-null" },
          dispatched: false,
        };
      }
      const eventClass = (await params.adapter.classify?.(input)) ?? {
        kind: "message" as const,
        canStartAgentTurn: true,
      };
      if (!eventClass.canStartAgentTurn) {
        return {
          admission: { kind: "handled" as const, reason: `event:${eventClass.kind}` },
          dispatched: false,
        };
      }
      const preflightValue = await params.adapter.preflight?.(input, eventClass);
      const preflight =
        preflightValue && "kind" in preflightValue
          ? { admission: preflightValue }
          : (preflightValue ?? {});
      if (
        preflight.admission &&
        preflight.admission.kind !== "dispatch" &&
        preflight.admission.kind !== "observeOnly"
      ) {
        return {
          admission: preflight.admission,
          dispatched: false,
        };
      }
      const resolved = await params.adapter.resolveTurn(input, eventClass, preflight ?? {});
      const admission =
        resolved.admission ?? preflight.admission ?? ({ kind: "dispatch" } as const);
      let dispatchResult;
      if ("runDispatch" in resolved) {
        if (params.turnAdoptionLifecycle) {
          const lifecycle = resolved.runDispatchLifecycle;
          if (!lifecycle) {
            throw new Error(
              "runChannelInboundEvent prepared turns must declare runDispatchLifecycle when creating runDispatch",
            );
          }
          if (lifecycle.turnAdoptionLifecycle !== params.turnAdoptionLifecycle) {
            throw new Error(
              "runChannelInboundEvent prepared turn runDispatchLifecycle must own the top-level turnAdoptionLifecycle",
            );
          }
        }
        const prepared =
          "route" in resolved
            ? (() => {
                const mergedRuntime = getRuntime();
                if (!mergedRuntime) {
                  throw new Error("plugin runtime mock run used before initialization");
                }
                const { cfg, route, ...turn } = resolved;
                return {
                  ...turn,
                  routeSessionKey: route.sessionKey,
                  storePath: mergedRuntime.channel.session.resolveStorePath(cfg.session?.store, {
                    agentId: route.agentId,
                  }),
                  recordInboundSession: mergedRuntime.channel.session.recordInboundSession,
                };
              })()
            : resolved;
        dispatchResult = await runPreparedChannelTurnMock({ ...prepared, admission });
      } else {
        const turn = {
          ...resolved,
          admission,
          ...(params.turnAdoptionLifecycle
            ? { turnAdoptionLifecycle: params.turnAdoptionLifecycle }
            : {}),
        };
        dispatchResult =
          "route" in turn
            ? await dispatchChannelTurnPlanMock(turn)
            : await dispatchAssembledChannelTurnMock(turn);
      }
      const result = {
        ...dispatchResult,
        admission,
      } as Parameters<NonNullable<typeof params.adapter.onFinalize>>[0];
      await params.adapter.onFinalize?.(result);
      return result;
    },
  );
  const buildChannelInboundEventContextMock = createGenericMock<Inbound["buildContext"]>(
    (params: BuildContextParams) => {
      const channelStructuredContext = resolveMockChannelStructuredContext(params);
      const extra = { ...params.extra };
      delete extra.UntrustedStructuredContext;
      const structuredContextField =
        channelStructuredContext === undefined
          ? {}
          : { ChannelStructuredContext: channelStructuredContext };
      return {
        Body: params.message.body ?? params.message.rawBody,
        BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
        RawBody: params.message.rawBody,
        CommandBody: params.message.commandBody ?? params.message.rawBody,
        BodyForCommands: params.message.commandBody ?? params.message.rawBody,
        From: params.from,
        To: params.reply.to,
        SessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
        AccountId: params.route.accountId ?? params.accountId,
        MessageSid: params.messageId,
        MessageSidFull: params.messageIdFull,
        ReplyToId: params.reply.replyToId ?? params.supplemental?.quote?.id,
        ReplyToIdFull: params.reply.replyToIdFull ?? params.supplemental?.quote?.fullId,
        media: params.media,
        ChatType: params.conversation.kind,
        ConversationLabel: params.conversation.label,
        SenderName: params.sender.name ?? params.sender.displayLabel,
        SenderId: params.sender.id,
        SenderUsername: params.sender.username,
        Timestamp: params.timestamp,
        WasMentioned: params.access?.mentions?.wasMentioned,
        GroupSystemPrompt: params.supplemental?.groupSystemPrompt,
        Provider: params.provider ?? params.channel,
        Surface: params.surface ?? params.provider ?? params.channel,
        OriginatingChannel: params.channel,
        OriginatingTo: params.reply.originatingTo,
        CommandAuthorized: params.access?.commands?.authorized ?? false,
        ...extra,
        ...structuredContextField,
      } as Awaited<BuildContextResult>;
    },
  );
  return {
    ingress: {
      createResolver: createChannelIngressPolicyResolver,
      resolve: resolveChannelIngressPolicy,
      resolveStable: resolveStableChannelIngressPolicy,
    },
    run: runChannelTurnMock,
    dispatch: dispatchChannelTurnPlanMock,
    dispatchReply: dispatchAssembledChannelTurnMock,
    buildContext: buildChannelInboundEventContextMock,
    runPreparedReply: runPreparedChannelTurnMock,
  } satisfies Inbound;
}
