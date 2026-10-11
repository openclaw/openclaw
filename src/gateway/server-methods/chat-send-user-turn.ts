import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { bindRequesterProfile } from "../../auto-reply/requester-profile.js";
import type { RuntimeMsgContext as MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_ECHO_TRANSCRIPT_FORMAT } from "../../media-understanding/echo-transcript.js";
import { readPersistedMediaFacts, type MediaFact } from "../../media/media-facts.js";
import { formatAudioTranscriptForAgent } from "../../plugin-sdk/media-understanding-runtime.js";
import { isProgressCardRefreshInputProvenance } from "../../sessions/input-provenance.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  isBrowserOperatorUiClient,
  isOperatorUiClient,
  isWebchatClient,
} from "../../utils/message-channel.js";
import {
  type ChatImageContent,
  type OffloadedRef,
  INLINE_IMAGE_DURABLE_OMISSION_MARKER,
  discardPreparedInboundMedia,
  persistInboundImagesForTranscript,
} from "../chat-attachments.js";
import { transferGatewayLocalUserIngress } from "../local-user-ingress.js";
import { resolveCreatorSandbox } from "../operator-role-policy.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { resolveGatewayInputParticipant } from "../session-input-participant.js";
import { prepareSkillLibrarySessionCreation } from "../skill-library-session.js";
import { captureGatewayUiCommandTarget } from "../ui-command-target.js";
import { isAcpBridgeClient } from "./chat-origin-routing.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { PreparedChatSendAttachments } from "./chat-send-attachments.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { resolveChatSendCallerContext } from "./gateway-client-identity.js";
import { isSyntheticGatewayCaller } from "./gateway-personal-caller.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

type ChatSendUserTurnInputController = {
  baseInput: UserTurnInput;
  setInputPromise: (input: Promise<UserTurnInput>) => void;
};

type PersistedChatSendMedia = Awaited<
  ReturnType<typeof persistInboundImagesForTranscript>
>["entries"];

const audioPreflightLoader = createLazyImportLoader(
  () => import("../../media-understanding/audio-preflight.js"),
);

async function resolveChatUiTranscriptEcho(params: {
  clientInfo: NormalizedChatSendRequest["clientInfo"];
  agentId: string;
  cfg: OpenClawConfig | undefined;
  ctx: MsgContext;
  assertCurrent: () => void;
}): Promise<string | undefined> {
  const audio = params.cfg?.tools?.media?.audio;
  const transcriptEchoClient =
    isWebchatClient(params.clientInfo) ||
    isOperatorUiClient(params.clientInfo) ||
    params.clientInfo?.id === GATEWAY_CLIENT_IDS.MACOS_APP ||
    params.clientInfo?.id === GATEWAY_CLIENT_IDS.IOS_APP ||
    params.clientInfo?.id === GATEWAY_CLIENT_IDS.ANDROID_APP;
  const echoFormat = audio?.echoFormat ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT;
  // A static/empty display format does not contain speech to persist. Leave
  // the attachment for ordinary media processing instead of consuming it here.
  if (
    !transcriptEchoClient ||
    !audio?.echoTranscript ||
    !echoFormat.includes("{transcript}") ||
    !params.ctx.media?.length
  ) {
    return undefined;
  }

  // Use the actual admitted turn context: audio scope rules depend on its
  // channel, chat type, and session key, and transcribeAudioAttachments marks the
  // same media facts later passed to agent dispatch as already transcribed.
  params.assertCurrent();
  const transcript = await audioPreflightLoader
    .load()
    .then(({ transcribeAudioAttachments }) =>
      transcribeAudioAttachments({
        ctx: params.ctx,
        ...(params.cfg
          ? {
              agentDir: resolveAgentDir(params.cfg, params.agentId),
              workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
            }
          : {}),
        // Gateway chat.send persists the echo in the canonical user turn;
        // never also send an outbound transcript message.
        cfg: {
          ...params.cfg,
          tools: {
            ...params.cfg?.tools,
            media: {
              ...params.cfg?.tools?.media,
              audio: { ...audio, echoTranscript: false },
            },
          },
        },
        assertCurrent: params.assertCurrent,
      }),
    )
    .catch(() => undefined);
  params.assertCurrent();
  if (!transcript) {
    return undefined;
  }

  // Audio is marked transcribed before the normal media pipeline runs, so
  // retain the result for the approval-aware agent context and canonical user
  // turn. Do not add it to the prompt until the canonical text is approved.
  params.ctx.Transcript = transcript;
  return echoFormat.replace("{transcript}", () => transcript);
}

async function persistChatSendImages(params: {
  images: ChatImageContent[];
  offloadedRefs: OffloadedRef[];
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
  assertCurrent?: () => void;
}): Promise<Awaited<ReturnType<typeof persistInboundImagesForTranscript>>> {
  if (
    (params.images.length === 0 && params.offloadedRefs.length === 0) ||
    isAcpBridgeClient(params.client)
  ) {
    return { entries: [], omission: "none" };
  }
  return await persistInboundImagesForTranscript({
    images: params.images,
    offloadedRefs: params.offloadedRefs,
    log: params.logGateway,
    logContext: "chat.send",
    assertCurrent: params.assertCurrent,
  });
}

function resolveChatSendManagedMedia(
  entries: PersistedChatSendMedia,
  suppressInlineHydration = false,
): MediaFact[] {
  return entries.map((entry) => ({
    path: entry.path,
    contentType: entry.fact.contentType ?? "application/octet-stream",
    ...(entry.fact.fileName ? { fileName: entry.fact.fileName } : {}),
    ...(suppressInlineHydration && entry.imageKind === "inline"
      ? { hydrationSuppressed: true }
      : {}),
  }));
}

type ChatSendManagedMediaApplyMode = "replace-empty" | "append-missing";

export function applyChatSendManagedMedia(
  ctx: MsgContext,
  media: MediaFact[],
  mode: ChatSendManagedMediaApplyMode = "replace-empty",
): void {
  if (media.length === 0) {
    return;
  }
  if (mode === "replace-empty") {
    if (!ctx.media || ctx.media.length === 0) {
      ctx.media = media;
    }
    return;
  }
  const existing = ctx.media ?? [];
  const existingPaths = new Set(existing.flatMap((fact) => (fact.path ? [fact.path] : [])));
  const missing = media.filter((fact) => !fact.path || !existingPaths.has(fact.path));
  if (missing.length > 0) {
    ctx.media = [...existing, ...missing];
  }
}

function buildChatSendPromptMedia(
  attachments: PreparedChatSendAttachments,
): MediaFact[] | undefined {
  if (!attachments.imageOrder.includes("offloaded")) {
    return undefined;
  }
  const media = attachments.offloadedRefs
    .filter((ref) => ref.mimeType.startsWith("image/"))
    .map((ref) => ({ path: ref.path, url: ref.mediaRef, contentType: ref.mimeType }));
  return media.length > 0 ? media : undefined;
}

/** Assemble transcript media and the portable inbound context after attachment preparation. */
export function prepareChatSendUserTurn(params: {
  request: Pick<
    NormalizedChatSendRequest,
    | "clientInfo"
    | "inboundMessage"
    | "suppressCommandInterpretation"
    | "systemInputProvenance"
    | "systemProvenanceReceipt"
    | "toolBindings"
  >;
  session: Pick<PreparedChatSendSession, "agentId" | "clientRunId" | "sessionKey"> &
    Partial<Pick<PreparedChatSendSession, "cfg">>;
  admission: Pick<AdmittedChatSend, "originatingRoute"> &
    Partial<Pick<AdmittedChatSend, "assertWorkAdmissionCurrent" | "assertClientUploadAllowed">>;
  attachments: PreparedChatSendAttachments;
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
  getConfig?: () => OpenClawConfig;
  userTurn: ChatSendUserTurnInputController;
}) {
  const { request, session, admission, attachments, client, logGateway, userTurn } = params;
  const persistedMediaForTranscriptPromise = persistChatSendImages({
    images: attachments.parsedImages,
    offloadedRefs: attachments.offloadedRefs,
    client,
    logGateway,
    assertCurrent: () => {
      admission.assertWorkAdmissionCurrent?.();
      admission.assertClientUploadAllowed?.();
    },
  });
  const pluginBoundMediaPromise =
    attachments.parsedImages.length > 0
      ? persistedMediaForTranscriptPromise.then((result) => {
          const entries = attachments.explicitOriginTargetsPlugin
            ? result.entries
            : result.entries.filter((entry) => entry.imageKind === "inline");
          return resolveChatSendManagedMedia(entries, !attachments.explicitOriginTargetsPlugin);
        })
      : Promise.resolve([]);
  void pluginBoundMediaPromise.catch(() => undefined);
  // Generated media hints belong to the prompt and reset payload, not command arguments.
  const commandBody = request.inboundMessage;
  const commandSource =
    !request.suppressCommandInterpretation && commandBody.trim().startsWith("/")
      ? "text"
      : undefined;
  const buildTextContext = (text: string) => {
    // The attachment parser appends managed-media hints after the original input.
    const parsedMessage =
      text === request.inboundMessage
        ? attachments.parsedMessage
        : `${text}${attachments.parsedMessage.slice(request.inboundMessage.length)}`;
    const body = request.systemProvenanceReceipt
      ? [request.systemProvenanceReceipt, parsedMessage].filter(Boolean).join("\n\n")
      : parsedMessage;
    return {
      Body: body,
      BodyForAgent: body,
      BodyForCommands: text,
      RawBody: parsedMessage,
      CommandBody: text,
    };
  };
  const queuedFollowupOwnerDeviceId = normalizeOptionalString(client?.connect?.device?.id);
  const queuedFollowupOwnerConnId = normalizeOptionalString(client?.connId);
  const gatewayUiCommandTarget = captureGatewayUiCommandTarget(client);
  const queuedFollowupOwnerKey = queuedFollowupOwnerDeviceId
    ? `device:${queuedFollowupOwnerDeviceId}`
    : queuedFollowupOwnerConnId
      ? `connection:${queuedFollowupOwnerConnId}`
      : undefined;
  const { originatingChannel, originatingTo, accountId, messageThreadId, explicitDeliverRoute } =
    admission.originatingRoute;
  const creation = resolveOperatorSessionCreation(client);
  admission.assertWorkAdmissionCurrent?.();
  const sandbox = session.cfg ? resolveCreatorSandbox(session.cfg, creation) : undefined;
  // Current and historical turns must reach the single LLM timestamp boundary
  // with identical bare text. Stamping this live turn would bust the prompt cache.
  const ctx: MsgContext = {
    ...buildTextContext(commandBody),
    InputProvenance: request.systemInputProvenance,
    ...(isProgressCardRefreshInputProvenance(request.systemInputProvenance)
      ? { InternalTurnSource: "progress-card-refresh" as const }
      : {}),
    SessionKey: session.sessionKey,
    AgentId: session.agentId,
    OriginatingTo: originatingTo,
    ExplicitDeliverRoute: explicitDeliverRoute,
    AccountId: accountId,
    MessageThreadId: messageThreadId,
    ...(commandSource ? { CommandSource: commandSource } : {}),
    CommandAuthorized: !request.suppressCommandInterpretation,
    CommandTurn: commandSource
      ? {
          kind: "text-slash",
          source: commandSource,
          authorized: true,
          body: commandBody,
        }
      : {
          kind: "normal",
          source: "message",
          authorized: false,
          body: commandBody,
        },
    ...(request.suppressCommandInterpretation ? { CommandInterpretationSuppressed: true } : {}),
    MessageSid: session.clientRunId,
    SessionCreation: { ...creation, ...(sandbox ? { sandbox } : {}) },
    ...resolveChatSendCallerContext(client, request.clientInfo, originatingChannel),
    GatewayRunToolBindings: request.toolBindings,
    GatewayUiCommandTarget: gatewayUiCommandTarget,
  };
  const requester = client?.authenticatedUserProfile;
  if (
    requester &&
    (client.authenticatedUserId || client.internal?.authenticatedOperator) &&
    isBrowserOperatorUiClient(request.clientInfo) &&
    !isSyntheticGatewayCaller(client) &&
    (!request.systemInputProvenance || request.systemInputProvenance.kind === "external_user")
  ) {
    const authenticatedUserId = client.authenticatedUserId;
    const { profileId, displayName } = requester;
    bindRequesterProfile(ctx, {
      id: profileId,
      displayName,
      isCurrent: () => {
        try {
          admission.assertWorkAdmissionCurrent?.();
        } catch {
          return false;
        }
        return (
          !client.invalidated &&
          !client.connectionSignal?.aborted &&
          !isSyntheticGatewayCaller(client) &&
          Boolean(client.authenticatedUserId || client.internal?.authenticatedOperator) &&
          client.authenticatedUserId === authenticatedUserId &&
          client.authenticatedUserProfile?.profileId === profileId
        );
      },
    });
  }
  if (client) {
    transferGatewayLocalUserIngress(client, ctx);
  }
  if (attachments.mediaPathOffloads.length > 0) {
    // Pre-staged offloads must use structured facts and marker text so the
    // dispatch path renders their prompt note without staging them a second time.
    ctx.media = attachments.mediaPathOffloads;
  }
  const mediaPathOffloadsIncludeImages = attachments.mediaPathOffloads.some((fact) =>
    fact.contentType?.startsWith("image/"),
  );
  let transcriptEchoForAgent: string | undefined;
  let machineTranscriptForAgent: string | undefined;
  let inlineImageOmitted = false;
  userTurn.setInputPromise(
    persistedMediaForTranscriptPromise.then(async (result) => {
      inlineImageOmitted = result.omission === "inline-image-save-failed";
      const media = result.entries.map((entry) => entry.fact);
      const slots = result.entries.flatMap((entry, factIndex) =>
        entry.imageKind ? [{ kind: entry.imageKind, factIndex }] : [],
      );
      const assertTranscriptCurrent = () => {
        admission.assertWorkAdmissionCurrent?.();
        admission.assertClientUploadAllowed?.();
      };
      const transcriptEcho = await resolveChatUiTranscriptEcho({
        clientInfo: request.clientInfo,
        agentId: session.agentId,
        cfg: session.cfg,
        ctx,
        assertCurrent: assertTranscriptCurrent,
      });
      if (transcriptEcho !== undefined && ctx.Transcript) {
        transcriptEchoForAgent = transcriptEcho;
        machineTranscriptForAgent = formatAudioTranscriptForAgent(ctx.Transcript);
      }
      return {
        ...userTurn.baseInput,
        ...(transcriptEcho
          ? { text: [userTurn.baseInput.text, transcriptEcho].filter(Boolean).join("\n") }
          : {}),
        ...(result.omission === "inline-image-save-failed"
          ? {
              text: [userTurn.baseInput.text, transcriptEcho, INLINE_IMAGE_DURABLE_OMISSION_MARKER]
                .filter(Boolean)
                .join("\n"),
            }
          : {}),
        ...(media.length > 0 ? { media } : {}),
        ...(slots.length > 0 ? { mediaImageLayout: { slots } } : {}),
      };
    }),
  );
  const participant = resolveGatewayInputParticipant(client, request.systemInputProvenance);
  if (participant) {
    prepareSessionParticipantInput(ctx, participant, userTurn.baseInput.timestamp);
  }
  return {
    prepareSessionCreation: async () => {
      if (!request.systemInputProvenance) {
        const prepared = await prepareSkillLibrarySessionCreation(
          client,
          params.getConfig ?? session.cfg ?? {},
          creation,
        );
        admission.assertWorkAdmissionCurrent?.();
        ctx.SessionCreation = { ...prepared, ...(sandbox ? { sandbox } : {}) };
      }
    },
    applyApprovedText: (text: string) => {
      if (text === request.inboundMessage.trim() && !machineTranscriptForAgent) {
        return;
      }
      Object.assign(ctx, buildTextContext(text));
      let approvedCaption = text;
      if (machineTranscriptForAgent) {
        // The durable omission note follows the display echo, but does not
        // change which speech or caption the write hook approved.
        const omissionSuffix =
          inlineImageOmitted && text.endsWith("\n" + INLINE_IMAGE_DURABLE_OMISSION_MARKER)
            ? INLINE_IMAGE_DURABLE_OMISSION_MARKER
            : undefined;
        const captionAndEcho = omissionSuffix ? text.slice(0, -(omissionSuffix.length + 1)) : text;
        const retainedEcho =
          transcriptEchoForAgent !== undefined &&
          (captionAndEcho === transcriptEchoForAgent ||
            captionAndEcho.endsWith("\n" + transcriptEchoForAgent));
        approvedCaption =
          retainedEcho && transcriptEchoForAgent !== undefined
            ? captionAndEcho === transcriptEchoForAgent
              ? ""
              : captionAndEcho.slice(0, -(transcriptEchoForAgent.length + 1))
            : captionAndEcho;
        const approvedContext = buildTextContext(approvedCaption);
        ctx.agentText = [
          approvedContext.BodyForAgent,
          retainedEcho ? machineTranscriptForAgent : undefined,
          omissionSuffix,
        ]
          .filter(Boolean)
          .join("\n");
        ctx.BodyForAgent = ctx.agentText;
        if (!retainedEcho) {
          ctx.Transcript = undefined;
        }
        // Command/raw consumers receive the approved caption and its managed
        // media hints; synthesized speech never becomes executable input.
        ctx.BodyForCommands = approvedContext.BodyForCommands;
        ctx.CommandBody = approvedContext.CommandBody;
        ctx.RawBody = approvedContext.RawBody;
      }
      if (ctx.CommandTurn) {
        ctx.CommandTurn = { ...ctx.CommandTurn, body: approvedCaption };
      }
    },
    discardUnreferencedMedia: async (approved: PersistedUserTurnMessage | undefined) => {
      if (!approved) {
        return;
      }
      const retained = new Set(
        (readPersistedMediaFacts(approved) ?? []).flatMap((fact) => [fact.url, fact.path]),
      );
      const prepared = await persistedMediaForTranscriptPromise;
      // Re-admission retains the original approved files. Dispose only copies
      // prepared by this request, after its live input consumer releases custody.
      await discardPreparedInboundMedia(
        prepared.entries.filter(
          (entry) => !retained.has(entry.fact.url) && !retained.has(entry.path),
        ),
        logGateway,
      );
    },
    accountId,
    ctx,
    isInternalTextSlashCommandTurn: commandSource === "text",
    queuedFollowupOwnerKey,
    pluginBoundMediaPromise,
    managedMediaApplyMode: attachments.explicitOriginTargetsPlugin
      ? ("replace-empty" as const)
      : ("append-missing" as const),
    replyOptionImages: mediaPathOffloadsIncludeImages
      ? undefined
      : attachments.parsedImages.length > 0
        ? attachments.parsedImages
        : undefined,
    replyOptionMedia: buildChatSendPromptMedia(attachments),
  };
}
