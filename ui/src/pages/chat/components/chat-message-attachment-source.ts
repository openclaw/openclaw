import { t } from "../../../i18n/index.ts";
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
  notifyChatMediaResourceSubscribers,
  observeChatMediaResource,
  scheduleChatMediaResourceRefresh,
  type AttachmentItem,
  type ArtifactDownloadResolver,
  type ChatMediaResource,
  type ImageRenderOptions,
} from "./chat-message-media.ts";

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

function resolveManagedAttachmentAvailability(
  attachment: AttachmentItem["attachment"],
  resolveArtifactDownload: ArtifactDownloadResolver | undefined,
  onRequestUpdate: (() => void) | undefined,
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
  const cacheKey = `${connectionEpoch ?? 0}::${attachment.url}::${attachment.artifactId}`;
  const resource = observeChatMediaResource<ManagedAttachmentAvailability>(
    "managed-media",
    cacheKey,
    onRequestUpdate,
    attachment.url,
  );
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
  const pending = Promise.resolve()
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
          const parsedExpiresAt = Date.parse(result?.expiresAt ?? "");
          const resolvedAt = Date.now();
          const expiresAt = Number.isFinite(parsedExpiresAt)
            ? parsedExpiresAt
            : resolvedAt + 5 * 60_000;
          const incoming: Extract<ManagedAttachmentAvailability, { status: "available" }> = {
            status: "available",
            url,
            expiresAt,
          };
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
      if (resource.pending === pending) {
        resource.pending = undefined;
      }
      notifyChatMediaResourceSubscribers(resource);
    });
  resource.pending = pending;
  if (current) {
    setManagedAttachmentAvailability(resource, current, true);
  }
  return current ?? { status: "checking" };
}

function retryManagedAttachmentAvailability(
  attachment: AttachmentItem["attachment"],
  onRequestUpdate: (() => void) | undefined,
  connectionEpoch: number | undefined,
): void {
  if (!attachment.artifactId || !isManagedOutgoingMediaSource(attachment.url)) {
    return;
  }
  const resource = observeChatMediaResource<ManagedAttachmentAvailability>(
    "managed-media",
    `${connectionEpoch ?? 0}::${attachment.url}::${attachment.artifactId}`,
    onRequestUpdate,
    attachment.url,
  );
  resource.value = undefined;
  resource.retryAttempted = false;
  notifyChatMediaResourceSubscribers(resource);
  onRequestUpdate?.();
}

export function resolveAttachmentSource(
  attachment: AttachmentItem["attachment"],
  options: ImageRenderOptions,
) {
  const { resourceBasePath, authToken, onRequestUpdate, resolveArtifactDownload, connectionEpoch } =
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
    onRequestUpdate,
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
          ? () => retryManagedAttachmentAvailability(attachment, onRequestUpdate, connectionEpoch)
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
