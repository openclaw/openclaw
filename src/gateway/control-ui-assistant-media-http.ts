import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { kindFromMime } from "@openclaw/media-core/mime";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { extractCanvasShortcodes } from "../chat/canvas-render.js";
import { readSessionPendingInput } from "../config/sessions/session-pending-input-history.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import { sameTranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { FsSafeError, openLocalFileSafely } from "../infra/fs-safe.js";
import { createHttpRequestAbortSignal } from "../infra/http-request-lifecycle.js";
import { buildInboundMediaUriFromPath } from "../media/inbound-media-path.js";
import { parseInboundMediaUri } from "../media/inbound-media-uri.js";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import { splitMediaFromOutput } from "../media/parse.js";
import {
  replacePlaybackFileExtension,
  resolvePlaybackTranscode,
} from "../media/playback-transcode.js";
import { extractOriginalFilename } from "../media/store.js";
import { ASSISTANT_DISPLAY_CONTENT_FIELD } from "../shared/assistant-display-content.js";
import { normalizeChatImageRenditionWidth } from "../shared/chat-image-renditions.js";
import {
  buildAssistantMediaContentDisposition,
  resolveAssistantMediaFilename,
} from "./assistant-media-content-disposition.js";
import {
  resolveAssistantMediaPolicy,
  resolveAssistantMediaWorkspaceTicketKey,
  assertAssistantMediaPolicyCurrent,
  verifyAssistantMediaTicket,
} from "./assistant-media-policy.js";
import {
  normalizeAssistantMediaSource,
  openAssistantMedia,
  respondAssistantMediaReadFailure,
  resolveAssistantMediaAvailability,
  resolveAssistantMediaSource,
} from "./control-ui-assistant-media-read.js";
import { applyControlUiSecurityHeaders } from "./control-ui-csp.js";
import {
  isReadHttpMethod,
  respondNotFound as respondControlUiNotFound,
  sendControlUiJson,
} from "./control-ui-http-utils.js";
import { resolveAssistantMediaRoutePath } from "./control-ui-resource-routes.js";
import { prepareHttpUserProfileCatalog } from "./http-auth-user-profile.js";
import { authorizeControlUiReadRequestOrReply } from "./http-auth-utils.js";
import {
  createGatewayByteStream,
  resolveByteResponse,
  writeByteHeaders,
} from "./http-byte-range.js";
import { applyHttpImageContentSecurityPolicy } from "./http-image-response.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import {
  getRemoteControlUiIngressContext,
  assertRemoteControlUiIngressCurrent,
} from "./ingress-attribution.js";
import { MAX_PAYLOAD_BYTES } from "./payload-limits.js";
import { projectPendingInputMessage } from "./server-methods/chat-pending-inputs.js";
import { readSessionMessageByIdAsync } from "./session-transcript-readers.js";

type MediaPolicy = NonNullable<Awaited<ReturnType<typeof resolveAssistantMediaPolicy>>>;

function messageMediaSources(message: unknown): string[] {
  const record = asOptionalRecord(message);
  if (!record) {
    return [];
  }
  const sources: unknown[] = (readPersistedMediaFacts(record) ?? []).flatMap((fact) => [
    fact.url,
    fact.path,
  ]);
  const display = record[ASSISTANT_DISPLAY_CONTENT_FIELD];
  const content = Array.isArray(display) ? display : (record.content ?? record.text);
  const assistant = record.role === "assistant";
  const addDirectives = (text: string) => {
    sources.push(
      ...(splitMediaFromOutput(extractCanvasShortcodes(text).text, {
        extractAudioDirectives: false,
      }).mediaUrls ?? []),
    );
  };
  if (assistant && typeof content === "string") {
    addDirectives(content);
  }
  for (const value of Array.isArray(content) ? content : []) {
    const block = asOptionalRecord(value);
    if (!block) {
      continue;
    }
    const source = asOptionalRecord(block.source);
    switch (block.type) {
      case "text":
      case "input_text":
      case "output_text":
        if (assistant && typeof block.text === "string") {
          addDirectives(block.text);
        }
        break;
      case "attachment":
        sources.push(asOptionalRecord(block.attachment)?.url);
        break;
      case "image":
        sources.push(block.url, block.openUrl, source?.url);
        break;
      case "image_url":
        sources.push(asOptionalRecord(block.image_url)?.url);
        break;
      case "input_image":
        sources.push(block.image_url, asOptionalRecord(block.image_url)?.url, source?.url);
        break;
      case "audio":
      case "video":
        sources.push(block.url, source?.type === "url" ? source.url : undefined);
        break;
    }
  }
  return sources.filter((source): source is string => typeof source === "string");
}

function mediaIdentity(source: string, policy: MediaPolicy) {
  const normalized = normalizeAssistantMediaSource(source);
  if (!normalized) {
    return undefined;
  }
  const inbound = parseInboundMediaUri(buildInboundMediaUriFromPath(normalized) ?? normalized);
  if (inbound) {
    return `media://inbound/${encodeURIComponent(inbound.id)}`;
  }
  const resolved = resolveAssistantMediaSource(normalized, policy);
  return resolved && path.isAbsolute(resolved) ? path.resolve(resolved) : undefined;
}

/** Bind narrow session readers to an existing visible message and its current media references. */
async function prepareAssistantMessageMedia(
  source: string,
  policy: MediaPolicy,
  signal: AbortSignal,
): Promise<(publish: () => void) => Promise<void>> {
  if (!policy.messageId) {
    return async (publish) => publish();
  }
  const messageId = policy.messageId;
  const loaded = policy.readSession();
  if (!loaded?.entry?.sessionId) {
    throw new FsSafeError("path-mismatch", "Message attachment unavailable");
  }
  const scope = {
    agentId: loaded.readSource?.agentId ?? loaded.agentId,
    sessionKey: loaded.canonicalKey,
    sessionId: loaded.entry.sessionId,
    storePath: loaded.readSource?.path ?? loaded.storePath,
    sessionEntry: loaded.entry,
  };
  const identity = mediaIdentity(source, policy);
  const assertAssociation = (message: unknown) => {
    signal.throwIfAborted();
    if (
      !identity ||
      !messageMediaSources(message).some(
        (candidate) => mediaIdentity(candidate, policy) === identity,
      )
    ) {
      throw new FsSafeError("path-mismatch", "Message attachment unavailable");
    }
  };
  if (messageId.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)) {
    const inputId = messageId.slice(CHAT_PENDING_INPUT_MESSAGE_PREFIX.length);
    // Attachment association needs visibility and media, not forwarded sender labels.
    const project = (input: Awaited<ReturnType<typeof readSessionPendingInput>>) =>
      input
        ? projectPendingInputMessage(input, MAX_PAYLOAD_BYTES, undefined, () => undefined)
        : undefined;
    assertAssociation(project(await readSessionPendingInput(scope, inputId)));
    return async (publish) => {
      let published = false;
      await readSessionPendingInput(scope, inputId, (current) => {
        assertAssociation(project(current));
        publish();
        published = true;
      });
      if (!published) {
        throw new FsSafeError("path-mismatch", "Message attachment unavailable");
      }
    };
  }
  const selection = { entryIds: [messageId] };
  const anchor = (await readSessionTranscriptAnchorsAsync(scope, selection, signal)).anchors[0];
  const selected =
    anchor &&
    (await readSessionMessageByIdAsync(
      scope,
      messageId,
      {
        currentOnly: true,
        maxBytes: MAX_PAYLOAD_BYTES,
        allowResetArchiveFallback: false,
        historyVisibility: {
          sessionStartedAt: loaded.entry.sessionStartedAt,
          requireVisible: true,
        },
      },
      signal,
    ));
  if (!anchor || !selected?.found || selected.oversized) {
    throw new FsSafeError("path-mismatch", "Message attachment unavailable");
  }
  assertAssociation(selected.message);
  return async (publish) => {
    let published = false;
    // Media enrichment can rewrite an existing message ID. The transcript owner
    // checks its anchor and holds write ordering until response publication starts.
    await readSessionTranscriptAnchorsAsync(scope, selection, signal, (current) => {
      if (!sameTranscriptEntryAnchor(anchor, current.anchors[0])) {
        throw new FsSafeError("path-mismatch", "Message attachment changed");
      }
      publish();
      published = true;
    });
    if (!published) {
      throw new FsSafeError("path-mismatch", "Message attachment changed");
    }
  };
}

export async function handleControlUiAssistantMediaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: Partial<GatewayHttpRequestAuthOptions> & {
    basePath?: string;
    config?: OpenClawConfig;
    agentId?: string;
  },
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  const url = new URL(urlRaw, "http://localhost");
  if (url.pathname !== resolveAssistantMediaRoutePath(opts?.basePath)) {
    return false;
  }
  const isMetaRequest = url.searchParams.get("meta") === "1";
  const explicitAllow =
    req.method === "POST" && isMetaRequest && url.searchParams.get("allow") === "1";
  if (!isReadHttpMethod(req.method) && !explicitAllow) {
    return false;
  }
  applyControlUiSecurityHeaders(res, getRemoteControlUiIngressContext(req));
  let source = normalizeAssistantMediaSource(url.searchParams.get("source") ?? "");
  if (!source) {
    respondControlUiNotFound(res);
    return true;
  }
  const sessionKey = url.searchParams.get("sessionKey")?.trim() || undefined;
  const messageId = sessionKey ? url.searchParams.get("messageId")?.trim() || undefined : undefined;
  const agentId = sessionKey ? url.searchParams.get("agentId")?.trim() || undefined : opts?.agentId;
  const relativeSource = !path.isAbsolute(source) && !/^[a-z][a-z0-9+.-]*:/iu.test(source);
  // Relative tickets bind the resolved path; authenticate their reader before resolving the cwd.
  const ticketCandidate = verifyAssistantMediaTicket(
    url.searchParams.get("mediaTicket"),
    relativeSource ? undefined : source,
    agentId,
  );
  const ingress = getRemoteControlUiIngressContext(req);
  if (ticketCandidate?.reader.authMethod === "remote-ingress" && !ingress) {
    respondControlUiNotFound(res);
    return true;
  }
  const needsAuthentication = Boolean(ingress) || isMetaRequest || !ticketCandidate;
  const requestAuth = needsAuthentication
    ? await authorizeControlUiReadRequestOrReply({
        ...opts,
        req,
        res,
        cfg: opts?.cfg ?? opts?.config,
        allowQueryToken: !explicitAllow,
        requiredOperatorMethod: messageId ? "chat.message.get" : "assistant.media.get",
      })
    : undefined;
  if (needsAuthentication && !requestAuth) {
    return true;
  }
  if (
    ingress &&
    ticketCandidate &&
    ticketCandidate.reader.profileId !== requestAuth?.authenticatedUserProfile?.profileId
  ) {
    respondControlUiNotFound(res);
    return true;
  }
  if (
    requestAuth?.authenticatedUserProfile?.profileId ||
    (!isMetaRequest && ticketCandidate?.reader.profileId)
  ) {
    if (
      !(await prepareHttpUserProfileCatalog(res)) ||
      requestAuth?.hasCurrentClientAuthority?.() === false ||
      (!isMetaRequest &&
        ticketCandidate &&
        !verifyAssistantMediaTicket(
          url.searchParams.get("mediaTicket"),
          relativeSource ? undefined : source,
          agentId,
        ))
    ) {
      if (!res.destroyed && !res.writableEnded) {
        respondControlUiNotFound(res);
      }
      return true;
    }
  }
  const policyParams = { config: opts?.config ?? {}, sessionKey, agentId, messageId };
  const policy = await resolveAssistantMediaPolicy({
    ...policyParams,
    requestAuth: requestAuth ?? undefined,
    reader: isMetaRequest || ingress ? undefined : ticketCandidate?.reader,
  });
  if (!policy) {
    respondControlUiNotFound(res);
    return true;
  }
  using mediaPolicy = { ...policy, [Symbol.dispose]: () => policy.release() };
  const resolvedSource = resolveAssistantMediaSource(source, policy);
  if (!resolvedSource) {
    respondControlUiNotFound(res);
    return true;
  }
  source = resolvedSource;
  const ticket = ticketCandidate?.source === source ? ticketCandidate : undefined;
  if (explicitAllow && !policy.canAllow) {
    sendControlUiJson(res, 403, { error: "Allowing an outside image requires operator.admin" });
    return true;
  }
  const sameSession =
    ticket &&
    ticket.session?.sessionKey === policy.session?.sessionKey &&
    ticket.session?.agentId === policy.session?.agentId &&
    ticket.session?.sessionId === policy.session?.sessionId &&
    ticket.messageId === policy.messageId &&
    ticket.workspaceKey === resolveAssistantMediaWorkspaceTicketKey(source, policy);
  if (!isMetaRequest && url.searchParams.has("mediaTicket") && (!ticket || !sameSession)) {
    respondControlUiNotFound(res);
    return true;
  }
  const allowance = explicitAllow
    ? true
    : ticket?.file && sameSession && policy.canAllow
      ? ticket.file
      : undefined;
  const assertCurrentPolicy = () => {
    assertRemoteControlUiIngressCurrent(getRemoteControlUiIngressContext(req));
    return assertAssistantMediaPolicyCurrent(
      policyParams,
      mediaPolicy,
      Boolean(allowance),
      requestAuth ?? undefined,
    );
  };
  const requestAbort = createHttpRequestAbortSignal(res.req, res);
  using _ = { [Symbol.dispose]: requestAbort.cleanup };
  let publishMessage: Awaited<ReturnType<typeof prepareAssistantMessageMedia>>;
  try {
    assertCurrentPolicy();
    publishMessage = await prepareAssistantMessageMedia(source, policy, requestAbort.signal);
    assertCurrentPolicy();
  } catch {
    respondControlUiNotFound(res);
    return true;
  }
  const publishResponse = (publish: () => void) =>
    publishMessage(() => {
      assertCurrentPolicy();
      publish();
    });
  if (isMetaRequest) {
    const { assertSourceCurrent, ...availability } = await resolveAssistantMediaAvailability(
      source,
      policy,
      allowance,
      agentId,
      requestAbort.signal,
      assertCurrentPolicy,
    );
    if (requestAbort.signal.aborted) {
      return true;
    }
    try {
      await publishResponse(() => {
        assertSourceCurrent?.();
        sendControlUiJson(
          res,
          200,
          !availability.available && availability.code === "outside-allowed-folders"
            ? { ...availability, retryable: false, ...(policy.canAllow ? { canAllow: true } : {}) }
            : availability,
        );
      });
    } catch {
      respondControlUiNotFound(res);
    }
    return true;
  }

  let byteStream: ReturnType<typeof createGatewayByteStream> | undefined;
  try {
    const media = await openAssistantMedia(source, policy, allowance, assertCurrentPolicy);
    let opened = media.opened;
    byteStream = createGatewayByteStream(res, opened.handle, () => respondControlUiNotFound(res));
    const mime = media.mimeType;
    let contentType = mime ?? "application/octet-stream";
    let filename =
      media.reference.kind === "inbound"
        ? resolveAssistantMediaFilename(
            extractOriginalFilename(media.reference.path),
            url.searchParams.get("filename"),
          )
        : path.basename(media.reference.path);
    const mediaKind = kindFromMime(contentType);
    // Local assistant-media previews retain their original animation bytes.
    if (
      media.reference.kind === "inbound" &&
      mediaKind === "image" &&
      url.searchParams.get("variant") === "thumbnail"
    ) {
      const { readImageThumbnailFromFile } = await import("./managed-image-thumbnail-cache.js");
      const thumbnail = await readImageThumbnailFromFile(
        opened,
        undefined,
        normalizeChatImageRenditionWidth(url.searchParams.get("width")),
      );
      await byteStream.close();
      await publishResponse(() => {
        res.setHeader("Content-Type", "image/webp");
        res.setHeader("Content-Length", String(thumbnail.byteLength));
        res.setHeader("Cache-Control", "private, no-cache");
        res.setHeader(
          "Content-Disposition",
          buildAssistantMediaContentDisposition(`${filename}-preview.webp`, "image/webp"),
        );
        res.end(req.method === "HEAD" ? undefined : thumbnail);
      });
      return true;
    }
    if (
      url.searchParams.get("playback") === "1" &&
      (mediaKind === "audio" || mediaKind === "video")
    ) {
      const playback = await resolvePlaybackTranscode({
        sourcePath: opened.realPath,
        sourceStat: {
          size: opened.stat.size,
          mtimeMs: opened.stat.mtimeMs,
          ctimeMs: opened.stat.ctimeMs,
          exactIdentity: opened.exactIdentity,
        },
        mimeType: contentType,
        kind: mediaKind,
        signal: byteStream.signal,
        assertCurrent: assertCurrentPolicy,
      });
      if (playback.kind === "preparing") {
        await byteStream.close();
        await publishResponse(() => sendControlUiJson(res, 202, { status: "preparing" }));
        return true;
      }
      if (playback.kind === "transcoded") {
        const transcoded = await openLocalFileSafely({ filePath: playback.path }).catch(() => null);
        if (transcoded) {
          await byteStream.close();
          opened = transcoded;
          byteStream = createGatewayByteStream(res, opened.handle, () =>
            respondControlUiNotFound(res),
          );
          contentType = playback.contentType;
          filename = replacePlaybackFileExtension(filename, playback.extension);
        }
      }
    }
    const byteResponse = resolveByteResponse({
      // Allowed paths are mutable; matching size and mtime cannot prove unchanged bytes.
      file: { size: opened.stat.size },
      method: req.method,
      request: req,
    });
    const emptyResponse =
      req.method === "HEAD" ||
      byteResponse.kind === "not-modified" ||
      byteResponse.contentLength === 0;
    if (emptyResponse) {
      await byteStream.close();
    }
    let delivery: Promise<void> | undefined;
    const stream = byteStream;
    await publishResponse(() => {
      media.assertSourceCurrent();
      // Allowed roots authorize file reads, not active document content.
      if (mediaKind === "image") {
        applyHttpImageContentSecurityPolicy(res);
      }
      res.setHeader("Content-Type", contentType);
      res.setHeader(
        "Content-Disposition",
        buildAssistantMediaContentDisposition(filename, contentType),
      );
      res.setHeader("Cache-Control", "no-cache");
      writeByteHeaders(res, byteResponse);
      if (emptyResponse) {
        res.end();
      } else {
        delivery = stream.pipe(byteResponse, req.method);
      }
    });
    await delivery;
    return true;
  } catch (error) {
    await byteStream?.close();
    await respondAssistantMediaReadFailure(error, source, res, publishResponse);
    return true;
  }
}
