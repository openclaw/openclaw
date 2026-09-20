import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { t } from "../../../i18n/index.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import type { MessageContentItem, MessageImageSource } from "../../../lib/chat/chat-types.ts";
import { readTranscriptMediaEntries } from "../../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import {
  isAudioTranscriptMediaPath,
  isImageMediaPath,
  isSvgImageMediaPath,
  isVideoTranscriptMediaPath,
  labelForMediaPath,
} from "../../../lib/media-file-extension.ts";

export type ImageBlock = {
  url: string;
  factIndex?: number;
  artifactId?: string;
  fileName?: string;
  openUrl?: string;
  alt?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
};

export type ArtifactDownloadResolver = (params: {
  sessionKey: string;
  artifactId: string;
}) => Promise<{ url: string; expiresAt?: string } | null>;

export type ImageRenderOptions = {
  galleryImages?: readonly ImageBlock[];
  sessionKey?: string;
  agentId?: string;
  policyKey?: string;
  canonicalMessageKey?: string;
  localSubmission?: boolean;
  connectionEpoch?: number;
  resourceBasePath?: string;
  authToken?: string | null;
  onRequestUpdate?: () => void;
  onRequestOpenImage?: () => number;
  onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
  resolveArtifactDownload?: ArtifactDownloadResolver;
};

export function assistantMediaPolicyKey(
  session: GatewaySessionRow | undefined,
  configEpoch = 0,
): string | undefined {
  if (!session && configEpoch === 0) {
    return undefined;
  }
  // These facts invalidate previews; the Gateway still owns the permission decision.
  return JSON.stringify([
    configEpoch,
    session?.permissionMode,
    session?.permissionModePending,
    session?.execNode,
    session?.execCwd,
    session?.sessionRoot,
    session?.spawnedWorkspaceDir,
    session?.spawnedCwd,
    session?.worktree?.id,
  ]);
}

export type AttachmentItem = Extract<MessageContentItem, { type: "attachment" }>;
type AttachmentFailureItem = Extract<MessageContentItem, { type: "attachment_error" }>;
export type AssistantAttachmentItem = AttachmentItem | AttachmentFailureItem;
export type ProjectedMessageContent =
  | { type: "text"; text: string }
  | { type: "image"; image: ImageBlock }
  | AssistantAttachmentItem;

type ChatMediaResourceKind =
  | "assistant-attachment"
  | "managed-image"
  | "managed-media"
  | "pairing-qr";

export type ChatMediaResource<Value> = {
  kind: ChatMediaResourceKind;
  cacheKey: string;
  cacheScope: string | undefined;
  discardWhenIdle: boolean;
  value: Value | undefined;
  pending: Promise<Value | null> | undefined;
  subscribers: Set<() => void>;
  retryAttempted: boolean;
  unavailableAt: number | undefined;
  abortController: AbortController | undefined;
  refresh: { at: number; timer: ReturnType<typeof setTimeout> } | undefined;
  retainUntil: number | undefined;
  releaseAuthRecovery?: () => void;
};

type ChatMediaSubscriber = {
  resources: Map<string, ChatMediaResource<unknown>>;
  children: Set<() => void>;
  owner?: () => void;
};

type ManagedImageBlobUrl = {
  blob: Blob;
  url: string;
  retainCount: number;
};

const chatMediaResources = new Map<string, ChatMediaResource<unknown>>();
const chatMediaSubscribers = new Map<() => void, ChatMediaSubscriber>();
const managedImageBlobUrls = new Map<string, ManagedImageBlobUrl>();
const CHAT_MEDIA_CACHE_MAX_ENTRIES = 64;
let chatMediaRenderVersion = 0;

function chatMediaResourceKey(kind: ChatMediaResourceKind, cacheKey: string): string {
  return `${kind}\0${cacheKey}`;
}

function getChatMediaSubscriber(subscriber: () => void): ChatMediaSubscriber {
  let state = chatMediaSubscribers.get(subscriber);
  if (!state) {
    state = { resources: new Map(), children: new Set() };
    chatMediaSubscribers.set(subscriber, state);
  }
  return state;
}

function pruneChatMediaSubscriber(subscriber: () => void, state: ChatMediaSubscriber): void {
  if (!state.owner && state.children.size === 0 && state.resources.size === 0) {
    chatMediaSubscribers.delete(subscriber);
  }
}

function detachChatMediaResourceSubscriber(
  resource: ChatMediaResource<unknown>,
  subscriber: () => void,
) {
  resource.subscribers.delete(subscriber);
  if (resource.subscribers.size > 0) {
    return;
  }
  resource.releaseAuthRecovery?.();
  resource.releaseAuthRecovery = undefined;
  clearChatMediaResourceRefresh(resource);
  const resourceKey = chatMediaResourceKey(resource.kind, resource.cacheKey);
  if (chatMediaResources.get(resourceKey) === resource) {
    chatMediaResources.delete(resourceKey);
    // Virtual rows release every subscriber while offscreen. Keep only settled
    // successes so remounts reuse their signed URL without retaining failed work.
    if (
      resource.retainUntil !== undefined &&
      resource.retainUntil > Date.now() &&
      !resource.discardWhenIdle &&
      !resource.pending
    ) {
      chatMediaResources.set(resourceKey, resource);
      trimIdleChatMediaResources();
    }
  }
  resource.abortController?.abort();
  resource.abortController = undefined;
}

export function observeChatMediaResource<Value>(
  kind: ChatMediaResourceKind,
  cacheKey: string,
  subscriber?: () => void,
  subscriberScope = cacheKey,
  cacheScope?: string,
): ChatMediaResource<Value> {
  const resourceKey = chatMediaResourceKey(kind, cacheKey);
  let resource = chatMediaResources.get(resourceKey) as ChatMediaResource<Value> | undefined;
  if (
    resource &&
    resource.subscribers.size === 0 &&
    (resource.discardWhenIdle ||
      (resource.retainUntil !== undefined && resource.retainUntil <= Date.now()))
  ) {
    chatMediaResources.delete(resourceKey);
    resource.abortController?.abort();
    clearChatMediaResourceRefresh(resource);
    resource = undefined;
  }
  if (!resource) {
    resource = {
      kind,
      cacheKey,
      cacheScope,
      discardWhenIdle: false,
      value: undefined,
      pending: undefined,
      subscribers: new Set(),
      retryAttempted: false,
      unavailableAt: undefined,
      abortController: undefined,
      refresh: undefined,
      retainUntil: undefined,
    };
    chatMediaResources.set(resourceKey, resource);
  }
  const newObservation = !subscriber || !resource.subscribers.has(subscriber);
  if (subscriber) {
    const subscriptions = getChatMediaSubscriber(subscriber).resources;
    const subscriptionKey = chatMediaResourceKey(kind, subscriberScope);
    const previous = subscriptions.get(subscriptionKey);
    // Protect the target from idle eviction before releasing the previous resource.
    resource.subscribers.add(subscriber);
    if (previous && previous !== resource) {
      detachChatMediaResourceSubscriber(previous, subscriber);
    }
    subscriptions.set(subscriptionKey, resource);
  }
  if (cacheScope !== undefined && newObservation) {
    // Policy changes can replace the directive. Let active readers finish, but
    // prevent superseded snapshots from becoming reusable when they later detach.
    for (const [key, sibling] of chatMediaResources) {
      if (sibling !== resource && sibling.kind === kind && sibling.cacheScope === cacheScope) {
        sibling.discardWhenIdle = true;
        if (sibling.subscribers.size === 0 && !sibling.pending) {
          chatMediaResources.delete(key);
        }
      }
    }
  }
  return resource;
}

function trimIdleChatMediaResources() {
  const retained = [...chatMediaResources.entries()].filter(
    ([, resource]) => resource.retainUntil !== undefined && resource.subscribers.size === 0,
  );
  for (const [resourceKey] of retained.slice(0, -CHAT_MEDIA_CACHE_MAX_ENTRIES)) {
    chatMediaResources.delete(resourceKey);
  }
}

export function isChatMediaResourceCurrent<Value>(resource: ChatMediaResource<Value>): boolean {
  return (
    chatMediaResources.get(chatMediaResourceKey(resource.kind, resource.cacheKey)) === resource
  );
}

export function getChatMediaRenderVersion(): number {
  return chatMediaRenderVersion;
}

export function notifyChatMediaResourceSubscribers<Value>(resource: ChatMediaResource<Value>) {
  if (!isChatMediaResourceCurrent(resource)) {
    return;
  }
  chatMediaRenderVersion = (chatMediaRenderVersion + 1) % Number.MAX_SAFE_INTEGER;
  // A pane can change its subscription while another pane is being notified.
  // Snapshot the current generation so a replacement never receives stale work.
  for (const subscriber of Array.from(resource.subscribers)) {
    if (resource.subscribers.has(subscriber)) {
      subscriber();
    }
  }
}

export function clearChatMediaResourceRefresh(resource: ChatMediaResource<unknown>) {
  if (resource.refresh) {
    clearTimeout(resource.refresh.timer);
    resource.refresh = undefined;
  }
}

export function scheduleChatMediaResourceRefresh<Value>(
  resource: ChatMediaResource<Value>,
  refreshAt: number | undefined,
  onRefresh: () => void,
) {
  if (resource.refresh?.at === refreshAt) {
    return;
  }
  clearChatMediaResourceRefresh(resource);
  if (refreshAt === undefined || resource.subscribers.size === 0) {
    return;
  }
  const refresh = {
    at: refreshAt,
    timer: setTimeout(
      () => {
        if (!isChatMediaResourceCurrent(resource) || resource.refresh !== refresh) {
          return;
        }
        resource.refresh = undefined;
        onRefresh();
      },
      Math.max(0, refreshAt - Date.now()),
    ),
  };
  resource.refresh = refresh;
}

export function observeChatMediaResourceSubscriber(owner: () => void, subscriber: () => void) {
  const state = getChatMediaSubscriber(subscriber);
  if (state.owner === owner) {
    return;
  }
  if (state.owner) {
    const previousOwner = state.owner;
    const previous = chatMediaSubscribers.get(previousOwner);
    if (previous) {
      previous.children.delete(subscriber);
      pruneChatMediaSubscriber(previousOwner, previous);
    }
  }
  getChatMediaSubscriber(owner).children.add(subscriber);
  state.owner = owner;
}

export function releaseChatMediaResourceSubscriber(subscriber: (() => void) | undefined) {
  const state = subscriber && chatMediaSubscribers.get(subscriber);
  if (!subscriber || !state) {
    return;
  }
  chatMediaSubscribers.delete(subscriber);
  for (const child of state.children) {
    releaseChatMediaResourceSubscriber(child);
  }
  if (state.owner) {
    const owner = chatMediaSubscribers.get(state.owner);
    if (owner) {
      owner.children.delete(subscriber);
      pruneChatMediaSubscriber(state.owner, owner);
    }
  }
  for (const resource of new Set(state.resources.values())) {
    detachChatMediaResourceSubscriber(resource, subscriber);
  }
}

export function trimManagedImageMissResources() {
  const misses = [...chatMediaResources.entries()].filter(
    ([, resource]) =>
      resource.kind === "managed-image" &&
      resource.value === null &&
      resource.subscribers.size === 0 &&
      !resource.pending,
  );
  for (const [resourceKey] of misses.slice(0, -CHAT_MEDIA_CACHE_MAX_ENTRIES)) {
    chatMediaResources.delete(resourceKey);
  }
}

export function readManagedImageBlobUrl(cacheKey: string): string | undefined {
  const cached = managedImageBlobUrls.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  managedImageBlobUrls.delete(cacheKey);
  managedImageBlobUrls.set(cacheKey, cached);
  return cached.url;
}

export function readManagedImageBlob(cacheKey: string): Blob | undefined {
  return managedImageBlobUrls.get(cacheKey)?.blob;
}

function trimManagedImageBlobUrlCache() {
  while (managedImageBlobUrls.size > CHAT_MEDIA_CACHE_MAX_ENTRIES) {
    const evictable = [...managedImageBlobUrls].find(([, cached]) => cached.retainCount === 0);
    if (!evictable) {
      return;
    }
    const [cacheKey, cached] = evictable;
    managedImageBlobUrls.delete(cacheKey);
    const resourceKey = chatMediaResourceKey("managed-image", cacheKey);
    const resource = chatMediaResources.get(resourceKey);
    // Subscriber-free successful resources share their blob's LRU lifetime.
    // The promise finalizer may still be queued, but a matching value is settled.
    if (resource?.value === cached.url && resource.subscribers.size === 0) {
      chatMediaResources.delete(resourceKey);
    }
    URL.revokeObjectURL(cached.url);
  }
}

export function retainManagedImageBlobUrl(cacheKey: string): (() => void) | undefined {
  const cached = managedImageBlobUrls.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  cached.retainCount += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const current = managedImageBlobUrls.get(cacheKey);
    if (current && current.retainCount > 0) {
      current.retainCount -= 1;
    }
    trimManagedImageBlobUrlCache();
  };
}

export function cacheManagedImageBlob(cacheKey: string, blob: Blob): string {
  const blobUrl = URL.createObjectURL(blob);
  const previous = managedImageBlobUrls.get(cacheKey);
  managedImageBlobUrls.delete(cacheKey);
  managedImageBlobUrls.set(cacheKey, {
    blob,
    url: blobUrl,
    retainCount: previous?.retainCount ?? 0,
  });
  if (previous && previous.url !== blobUrl) {
    URL.revokeObjectURL(previous.url);
  }

  // Blob URLs retain browser-managed image data. Keep recent previews reusable,
  // but protect an image while its lightbox still uses that object URL.
  trimManagedImageBlobUrlCache();
  return blobUrl;
}

function appendImageBlock(images: ImageBlock[], block: ImageBlock) {
  if (
    !images.some((entry) =>
      block.factIndex !== undefined
        ? entry.factIndex === block.factIndex
        : entry.factIndex === undefined && entry.url === block.url && entry.alt === block.alt,
    )
  ) {
    images.push(block);
    return true;
  }
  return false;
}

export function projectMessageMedia(
  message: unknown,
  content: readonly MessageContentItem[],
  nowMs = Date.now(),
) {
  const record = asNonArrayRecord(message);
  const images: ImageBlock[] = [];
  const attachments: AssistantAttachmentItem[] = [];
  const orderedContent: ProjectedMessageContent[] = [];
  const supplementalImages: ImageBlock[] = [];
  const supplementalAttachments: AssistantAttachmentItem[] = [];
  const positionedSources = new Set<string>();
  const attachmentUrls = new Set<string>();
  let expiredPairingQrCount = 0;
  let nextPairingQrExpiresAt: number | undefined;
  const appendAttachment = (item: AssistantAttachmentItem) => {
    if (item.type === "attachment_error" || !attachmentUrls.has(item.attachment.url)) {
      attachments.push(item);
      if (item.type === "attachment") {
        attachmentUrls.add(item.attachment.url);
      }
      return true;
    }
    return false;
  };
  const projectSvgAttachment = (source: MessageImageSource): AttachmentItem | undefined => {
    if (!source.url || !isSvgImageMediaPath(source.url, source.mimeType)) {
      return undefined;
    }
    try {
      const url = new URL(source.url, window.location.href);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.origin === window.location.origin
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return {
      type: "attachment",
      attachment: {
        url: source.url,
        kind: "image",
        label: source.fileName?.trim() || source.alt?.trim() || labelForMediaPath(source.url),
        mimeType: source.mimeType ?? "image/svg+xml",
        ...(source.artifactId !== undefined ? { artifactId: source.artifactId } : {}),
        ...(source.sizeBytes !== undefined ? { sizeBytes: source.sizeBytes } : {}),
      },
    };
  };
  const layout = asNonArrayRecord(asNonArrayRecord(record["__openclaw"]).mediaImageLayout);
  const slots = Array.isArray(layout.slots) ? layout.slots.map(asNonArrayRecord) : [];
  const factIndexes = slots.length > 0 ? new Set(slots.map((slot) => slot.factIndex)) : undefined;
  // Reject ambiguous layouts before deduplication: fact positions, including
  // holes and duplicate sources, are the persisted attachment identity.
  const validLayout =
    factIndexes !== undefined &&
    !(Array.isArray(layout.suppressedFactIndexes) && layout.suppressedFactIndexes.length > 0) &&
    slots.every(
      (slot) =>
        (slot.kind === "inline" || slot.kind === "offloaded") &&
        typeof slot.factIndex === "number" &&
        Number.isSafeInteger(slot.factIndex) &&
        slot.factIndex >= 0,
    ) &&
    factIndexes.size === slots.length;
  const inlineSlots = validLayout ? slots.filter((slot) => slot.kind === "inline") : [];
  let inlineIndex = 0;

  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      const previous = orderedContent.at(-1);
      if (previous?.type === "text") {
        previous.text += `\n${item.text}`;
      } else {
        orderedContent.push({ type: "text", text: item.text });
      }
      continue;
    }
    if (item.type === "attachment" || item.type === "attachment_error") {
      appendAttachment(item);
      orderedContent.push(item);
      if (item.type === "attachment") {
        positionedSources.add(item.attachment.url);
      }
      continue;
    }
    if (item.type === "omitted_media") {
      inlineIndex += 1;
      continue;
    }
    if (item.type !== "image") {
      continue;
    }
    if (item.expiresAtMs !== undefined) {
      if (item.expiresAtMs <= nowMs) {
        expiredPairingQrCount += 1;
        continue;
      }
      nextPairingQrExpiresAt = Math.min(
        nextPairingQrExpiresAt ?? item.expiresAtMs,
        item.expiresAtMs,
      );
    }
    const factIndex = item.inlineSlot ? inlineSlots[inlineIndex++]?.factIndex : undefined;
    const blockImages: ImageBlock[] = [];
    const blockAttachments = new Set<string>();
    for (const source of item.sources) {
      const { url: sourceUrl, dataUrl, preferData, mimeType: _mimeType, ...metadata } = source;
      if (sourceUrl !== undefined) {
        positionedSources.add(sourceUrl);
      }
      const svg = projectSvgAttachment(source);
      if (svg && !blockAttachments.has(svg.attachment.url)) {
        appendAttachment(svg);
        orderedContent.push(svg);
        blockAttachments.add(svg.attachment.url);
      }
      const url = preferData
        ? (dataUrl ?? (svg ? undefined : sourceUrl))
        : ((svg ? undefined : sourceUrl) ?? dataUrl);
      if (url !== undefined) {
        appendImageBlock(blockImages, {
          ...metadata,
          url,
          ...(typeof factIndex === "number" ? { factIndex } : {}),
        });
      }
    }
    // Separate blocks are separate attachments, including identical uploads.
    images.push(...blockImages);
    orderedContent.push(...blockImages.map((image) => ({ type: "image" as const, image })));
  }
  // Only a complete inline layout may lend its fact positions to mounted previews.
  if (inlineIndex !== inlineSlots.length) {
    for (const image of images) {
      delete image.factIndex;
    }
  }
  for (const {
    path: mediaPath,
    mediaType,
    fileName,
    origin,
    sizeBytes,
    durationMs,
    width,
    height,
    factIndex,
  } of readTranscriptMediaEntries(message)) {
    const image = isImageMediaPath(mediaPath, mediaType);
    const svg = image && isSvgImageMediaPath(mediaPath, mediaType);
    if (image && !svg) {
      const projected: ImageBlock = {
        url: mediaPath,
        fileName,
        sizeBytes,
        ...(validLayout && factIndexes.has(factIndex) ? { factIndex } : {}),
      };
      if (appendImageBlock(images, projected) && !positionedSources.has(mediaPath)) {
        supplementalImages.push(projected);
      }
    } else {
      const projected: AttachmentItem = {
        type: "attachment",
        attachment: {
          url: mediaPath,
          kind: svg
            ? "image"
            : isAudioTranscriptMediaPath(mediaPath, mediaType)
              ? "audio"
              : isVideoTranscriptMediaPath(mediaPath, mediaType)
                ? "video"
                : "document",
          label: fileName?.trim() || labelForMediaPath(mediaPath),
          ...(origin ? { origin } : {}),
          ...(typeof mediaType === "string" ? { mimeType: mediaType } : {}),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
        },
      };
      if (appendAttachment(projected) && !positionedSources.has(mediaPath)) {
        supplementalAttachments.push(projected);
      }
    }
  }
  return {
    images,
    attachments,
    orderedContent,
    supplementalImages,
    supplementalAttachments,
    expiredPairingQrCount,
    nextPairingQrExpiresAt,
  };
}

export function schedulePairingQrExpiryRefresh(
  messageKey: string,
  refreshAt: number | undefined,
  onRequestUpdate: (() => void) | undefined,
) {
  if (!onRequestUpdate) {
    return;
  }
  if (refreshAt === undefined) {
    const subscriber = chatMediaSubscribers.get(onRequestUpdate);
    const resourceKey = chatMediaResourceKey("pairing-qr", messageKey);
    const resource = subscriber?.resources.get(resourceKey);
    if (subscriber && resource) {
      subscriber.resources.delete(resourceKey);
      detachChatMediaResourceSubscriber(resource, onRequestUpdate);
      pruneChatMediaSubscriber(onRequestUpdate, subscriber);
    }
    return;
  }
  const resource = observeChatMediaResource<void>("pairing-qr", messageKey, onRequestUpdate);
  scheduleChatMediaResourceRefresh(resource, refreshAt, () =>
    notifyChatMediaResourceSubscribers(resource),
  );
}

// Reply previews and completed-run actions describe the media the bubble renders.
export function extractMessageMediaText(
  message: unknown,
  content = normalizeMessage(message).content,
): string {
  const { images, attachments } = projectMessageMedia(message, content);
  return [
    ...images.map(
      (image) => image.fileName?.trim() || image.alt?.trim() || t("chat.imageLightbox.untitled"),
    ),
    ...content.flatMap((item) => {
      if (item.type !== "omitted_media") {
        return [];
      }
      const reason =
        item.media.sizeBytes === undefined
          ? t("chat.attachments.omittedFromHistory")
          : t("chat.attachments.omittedFromHistoryWithSize", {
              size: formatBytes(item.media.sizeBytes),
            });
      return [`${t("chat.attachments.image")} · ${reason}`];
    }),
    ...attachments.map(
      (item) => item.attachment.label.trim() || t("chat.attachments.attachedFile"),
    ),
  ].join("\n");
}
