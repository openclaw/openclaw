import { toErrorObject } from "@openclaw/normalization-core";
import { fetchControlUiResource } from "../../../app/browser-http.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { safeMediaAttachmentHref, safePlainTextAttachmentHref } from "./chat-attachment-href.ts";
import {
  ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES,
  ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS,
  ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS,
  isManagedOutgoingMediaSource,
  resolveAssistantAttachmentAvailability,
  resolveManagedOutgoingMediaSessionKey,
  retryAssistantAttachmentAvailability,
} from "./chat-message-attachment-availability.ts";
import {
  applyResourceBasePath,
  buildAssistantAttachmentUrl,
  isLocalAssistantAttachmentSource,
} from "./chat-message-local-media.ts";
import {
  isChatMediaResourceCurrent,
  releaseChatMediaResourceOwner,
  notifyChatMediaResourceSubscribers,
  observeChatMediaResource,
  scheduleChatMediaResourceRefresh,
  type AttachmentItem,
  type ArtifactDownloadResolver,
  type ChatMediaResource,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";
import type { AttachmentSidebarState } from "./chat-sidebar-content-types.ts";

registerChatComposerEnglish();

type ManagedAttachmentAvailability =
  | { status: "checking"; refreshAfter?: number; refreshAttempts?: number }
  | {
      status: "available";
      url: string;
      expiresAt?: number;
      refreshAfter?: number;
      refreshAttempts?: number;
    }
  | { status: "unavailable"; reason: string; checkedAt: number; error?: true };

function unavailableManagedAttachment(): ManagedAttachmentAvailability {
  return {
    status: "unavailable",
    reason: t("chat.attachments.unavailable"),
    checkedAt: Date.now(),
  };
}

function retryManagedAttachment(
  candidate: Extract<ManagedAttachmentAvailability, { status: "available" }> | null,
  refreshAttempts: number,
  now = Date.now(),
): ManagedAttachmentAvailability {
  const available =
    candidate?.expiresAt !== undefined && candidate.expiresAt <= now ? null : candidate;
  if (refreshAttempts >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES) {
    // Exhaustion stops renewal, not playback: retain a valid ticket only until its expiry.
    return available?.expiresAt
      ? { ...available, refreshAfter: available.expiresAt, refreshAttempts }
      : unavailableManagedAttachment();
  }
  return {
    ...(available ?? { status: "checking" }),
    refreshAfter: now + ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS * 2 ** refreshAttempts,
    refreshAttempts: refreshAttempts + 1,
  };
}

function setManagedAttachmentAvailability(
  resource: ChatMediaResource<ManagedAttachmentAvailability>,
  availability: ManagedAttachmentAvailability,
  scheduleExpiryOnly = false,
): ManagedAttachmentAvailability {
  if (!isChatMediaResourceCurrent(resource)) {
    return availability;
  }
  resource.value = availability;
  const refreshAt =
    availability.status === "checking"
      ? availability.refreshAfter
      : availability.status === "available" && availability.expiresAt !== undefined
        ? scheduleExpiryOnly
          ? availability.expiresAt
          : Math.min(
              availability.refreshAfter ??
                availability.expiresAt - ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS,
              availability.expiresAt,
            )
        : availability.status === "unavailable" && !resource.retryAttempted
          ? availability.checkedAt + ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS
          : undefined;
  scheduleChatMediaResourceRefresh(resource, refreshAt, () => {
    if (resource.value?.status === "unavailable") {
      resource.retryAttempted = true;
      resource.value = undefined;
    }
    notifyChatMediaResourceSubscribers(resource);
  });
  return availability;
}

function managedAttachmentGrant(url: string, expiresAt: string | undefined, now: number) {
  const parsed = Date.parse(expiresAt ?? "");
  return {
    status: "available" as const,
    url,
    expiresAt: Number.isFinite(parsed) ? parsed : now + 5 * 60_000,
  };
}

export function prepareManagedAttachmentGrant(
  scope: { sessionKey: string; artifactId: string; connectionEpoch?: number },
  signal: AbortSignal,
) {
  const owner = () => {};
  const resource = observeChatMediaResource<ManagedAttachmentAvailability>(
    "managed-media",
    `${scope.connectionEpoch ?? 0}::${scope.sessionKey}::${scope.artifactId}`,
    owner,
  );
  const release = () => releaseChatMediaResourceOwner(owner);
  const stopAbort = listen(signal, "abort", release, { once: true });
  if (signal.aborted) {
    release();
  }
  // Holding the native resource distinguishes retirement/recreation from an unchanged miss.
  return {
    sessionKey: scope.sessionKey,
    artifactId: scope.artifactId,
    resource,
    value: resource.value,
    owner,
    release: () => {
      stopAbort();
      release();
    },
  };
}

export function admitManagedAttachmentGrant(
  receipt: ReturnType<typeof prepareManagedAttachmentGrant>,
  attachment: AttachmentItem["attachment"],
  expiresAt: string | undefined,
): void {
  const resource = receipt.resource;
  if (
    !isChatMediaResourceCurrent(resource) ||
    !resource.subscribers.has(receipt.owner) ||
    resource.value !== receipt.value ||
    resource.pending ||
    attachment.artifactId !== receipt.artifactId ||
    !isManagedOutgoingMediaSource(attachment.url) ||
    resolveManagedOutgoingMediaSessionKey(attachment.url) !== receipt.sessionKey
  ) {
    return;
  }
  const now = Date.now();
  const grant = managedAttachmentGrant(attachment.url, expiresAt, now);
  if (grant.expiresAt - now <= ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS) {
    return;
  }
  resource.retryAttempted = false;
  resource.retainUntil = grant.expiresAt;
  setManagedAttachmentAvailability(resource, grant);
  notifyChatMediaResourceSubscribers(resource);
}

function resolveManagedAttachmentAvailability(
  attachment: AttachmentItem["attachment"],
  resolveArtifactDownload: ArtifactDownloadResolver | undefined,
  onMediaChange: (() => void) | undefined,
  connectionEpoch: number | undefined,
): ManagedAttachmentAvailability {
  if (!isManagedOutgoingMediaSource(attachment.url)) {
    return { status: "available", url: attachment.url };
  }
  if (!attachment.artifactId || !resolveArtifactDownload) {
    if (new URL(attachment.url, window.location.origin).searchParams.get("mediaTicket")?.trim()) {
      return { status: "available", url: attachment.url };
    }
    return unavailableManagedAttachment();
  }
  const sessionKey = resolveManagedOutgoingMediaSessionKey(attachment.url);
  if (!sessionKey) {
    return unavailableManagedAttachment();
  }
  const cacheKey = `${connectionEpoch ?? 0}::${sessionKey}::${attachment.artifactId}`;
  const resource = observeChatMediaResource<ManagedAttachmentAvailability>(
    "managed-media",
    cacheKey,
    onMediaChange,
    attachment.url,
  );
  if (onMediaChange) {
    // The reader adopts prepared idle retention and resumes the normal subscriber lifecycle.
    resource.retainUntil = undefined;
  }
  const cached = resource.value;
  const now = Date.now();
  if (
    cached?.status === "unavailable" ||
    (cached?.status === "checking" &&
      cached.refreshAfter !== undefined &&
      cached.refreshAfter > now)
  ) {
    return setManagedAttachmentAvailability(resource, cached);
  }
  if (cached?.status === "available") {
    const expired = cached.expiresAt !== undefined && cached.expiresAt <= now;
    if (
      expired &&
      (cached.refreshAttempts ?? 0) >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES
    ) {
      resource.retryAttempted = true;
      return setManagedAttachmentAvailability(resource, unavailableManagedAttachment());
    }
    if (
      expired &&
      (resource.pending || (cached.refreshAfter !== undefined && cached.refreshAfter > now))
    ) {
      return setManagedAttachmentAvailability(resource, {
        status: "checking",
        refreshAfter: resource.pending ? undefined : cached.refreshAfter,
        refreshAttempts: cached.refreshAttempts,
      });
    }
    const refreshAt =
      cached.refreshAfter ??
      (cached.expiresAt === undefined
        ? undefined
        : cached.expiresAt - ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS);
    if (refreshAt === undefined || refreshAt > now) {
      return setManagedAttachmentAvailability(resource, cached);
    }
  }
  if (resource.pending) {
    return cached?.status === "available" ? cached : { status: "checking" };
  }
  const current =
    cached?.status === "available" && (cached.expiresAt === undefined || cached.expiresAt > now)
      ? cached
      : null;
  const refreshAttempts = cached?.refreshAttempts ?? 0;
  const handleResolutionFailure = () =>
    current || cached?.status === "checking"
      ? retryManagedAttachment(current, refreshAttempts)
      : unavailableManagedAttachment();
  if (!current) {
    setManagedAttachmentAvailability(resource, { status: "checking" });
  }
  resource.pending = Promise.resolve()
    .then(async () => {
      let availability: ManagedAttachmentAvailability;
      try {
        const result = await resolveArtifactDownload({
          sessionKey,
          artifactId: attachment.artifactId!,
        });
        const url = result?.url.trim();
        if (!url) {
          availability = handleResolutionFailure();
        } else {
          const resolvedAt = Date.now();
          const incoming = managedAttachmentGrant(url, result?.expiresAt, resolvedAt);
          const expiresAt = incoming.expiresAt;
          availability =
            expiresAt - resolvedAt > ASSISTANT_ATTACHMENT_MEDIA_TICKET_REFRESH_SKEW_MS
              ? incoming
              : retryManagedAttachment(
                  refreshAttempts >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES &&
                    current?.expiresAt !== undefined &&
                    current.expiresAt >= expiresAt
                    ? current
                    : incoming,
                  refreshAttempts,
                  resolvedAt,
                );
        }
      } catch {
        availability = handleResolutionFailure();
        if (availability.status === "unavailable") {
          availability = { ...availability, error: true };
        }
      }
      if (!isChatMediaResourceCurrent(resource)) {
        return null;
      }
      if (availability.status === "available" && availability.refreshAttempts === undefined) {
        resource.retryAttempted = false;
      } else if (
        availability.status === "unavailable" &&
        refreshAttempts >= ASSISTANT_ATTACHMENT_MEDIA_TICKET_MAX_REFRESH_RETRIES
      ) {
        resource.retryAttempted = true;
      }
      return setManagedAttachmentAvailability(resource, availability);
    })
    .finally(() => {
      resource.pending = undefined;
      notifyChatMediaResourceSubscribers(resource);
    });
  if (current) {
    setManagedAttachmentAvailability(resource, current, true);
  }
  return current ?? { status: "checking" };
}

export function resolveAttachmentSource(
  attachment: AttachmentItem["attachment"],
  options: ImageRenderOptions,
) {
  const { resourceBasePath, authToken, onMediaChange, resolveArtifactDownload, connectionEpoch } =
    options;
  const assistantAvailability = resolveAssistantAttachmentAvailability(attachment.url, options);
  if (assistantAvailability.status !== "available") {
    return {
      status: assistantAvailability.status,
      reason:
        assistantAvailability.status === "unavailable" ? assistantAvailability.reason : undefined,
      error: assistantAvailability.status === "unavailable" && assistantAvailability.unconfirmed,
      onAllow:
        assistantAvailability.status === "unavailable" && assistantAvailability.canAllow
          ? () => retryAssistantAttachmentAvailability(attachment.url, options, true)
          : undefined,
      onRetry:
        assistantAvailability.status === "unavailable" && assistantAvailability.recoverable
          ? () => retryAssistantAttachmentAvailability(attachment.url, options)
          : undefined,
    };
  }
  const managedAvailability = resolveManagedAttachmentAvailability(
    attachment,
    resolveArtifactDownload,
    onMediaChange,
    connectionEpoch,
  );
  if (managedAvailability.status !== "available") {
    return {
      status: managedAvailability.status,
      reason: managedAvailability.status === "unavailable" ? managedAvailability.reason : undefined,
      error: managedAvailability.status === "unavailable" && managedAvailability.error,
      onRetry:
        managedAvailability.status === "unavailable" &&
        attachment.artifactId &&
        resolveArtifactDownload
          ? (): void => {
              if (!attachment.artifactId || !isManagedOutgoingMediaSource(attachment.url)) {
                return;
              }
              const resource = observeChatMediaResource<ManagedAttachmentAvailability>(
                "managed-media",
                `${connectionEpoch ?? 0}::${resolveManagedOutgoingMediaSessionKey(attachment.url)}::${attachment.artifactId}`,
                onMediaChange,
                attachment.url,
              );
              resource.value = undefined;
              resource.retryAttempted = false;
              notifyChatMediaResourceSubscribers(resource);
              onMediaChange?.();
            }
          : undefined,
    };
  }
  const localSource = isLocalAssistantAttachmentSource(attachment.url);
  const src = localSource
    ? buildAssistantAttachmentUrl(
        attachment.url,
        resourceBasePath,
        assistantAvailability.mediaTicket,
        options,
        attachment.label,
      )
    : isManagedOutgoingMediaSource(attachment.url)
      ? applyResourceBasePath(managedAvailability.url, resourceBasePath)
      : managedAvailability.url;
  if (!src) {
    return { status: "checking" as const, reason: undefined, onRetry: undefined };
  }
  const playback = assistantAvailability.playback ?? attachment.playback ?? "native";
  return {
    status: "available" as const,
    source: {
      src,
      playback,
      authToken: localSource ? (authToken ?? null) : null,
      sizeBytes: assistantAvailability.sizeBytes ?? attachment.sizeBytes,
      durationMs: assistantAvailability.durationMs ?? attachment.durationMs,
      width: assistantAvailability.width ?? attachment.width,
      height: assistantAvailability.height ?? attachment.height,
    },
  };
}

export function resolveAttachmentSidebarSource(
  attachment: AttachmentItem["attachment"],
  options: ImageRenderOptions,
): AttachmentSidebarState {
  const next = resolveAttachmentSource(attachment, options);
  if (next.status === "available") {
    return { status: "ready", ...next.source };
  }
  if (next.status === "checking") {
    return { status: "pending" };
  }
  return next.error
    ? {
        status: "error",
        reason: next.reason ?? t("chat.attachments.unavailable"),
        onRetry: next.onRetry,
      }
    : { status: "unavailable", onRetry: next.onRetry };
}

/** Resolve fresh authorization at the media owner, then read within the caller's attachment budget. */
export async function readAttachmentSource(
  attachment: AttachmentItem["attachment"],
  options: ImageRenderOptions,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Blob | null> {
  if (signal.aborted) {
    return null;
  }
  let changed = () => {};
  let stopAbort = () => {};
  let resolved: ReturnType<typeof resolveAttachmentSource> | null;
  try {
    resolved = await new Promise<ReturnType<typeof resolveAttachmentSource> | null>(
      (resolve, reject) => {
        changed = () => {
          try {
            const source = resolveAttachmentSource(attachment, {
              ...options,
              onMediaChange: changed,
            });
            if (source.status !== "checking") {
              resolve(source);
            }
          } catch (error) {
            reject(toErrorObject(error, t("chat.attachments.unavailable")));
          }
        };
        stopAbort = listen(signal, "abort", () => resolve(null), { once: true });
        if (signal.aborted) {
          resolve(null);
        } else {
          changed();
        }
      },
    );
  } finally {
    stopAbort();
    releaseChatMediaResourceOwner(changed);
  }
  if (signal.aborted || !resolved) {
    return null;
  }
  if (resolved.status !== "available") {
    throw new Error(resolved.reason ?? t("chat.attachments.unavailable"));
  }
  const url =
    attachment.kind === "audio" || attachment.kind === "video"
      ? safeMediaAttachmentHref(resolved.source.src, attachment.kind)
      : safePlainTextAttachmentHref(resolved.source.src);
  if (!url) {
    throw new Error(t("chat.attachments.unavailable"));
  }
  const response = await fetchControlUiResource(url, {
    credentials: "same-origin",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(t("chat.attachments.unavailable"));
  }
  const bytes = await readResponseBytesWithinLimit(response, maxBytes);
  if (signal.aborted) {
    return null;
  }
  if (!bytes) {
    throw new Error(t("chat.attachments.tooLargeToast"));
  }
  return new Blob([bytes], {
    type: attachment.mimeType || response.headers.get("content-type") || "application/octet-stream",
  });
}
