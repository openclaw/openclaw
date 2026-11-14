import type { ChatImageRenditionWidth } from "../../../../../src/shared/chat-image-renditions.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import type { MessageContentItem } from "../../../lib/chat/chat-types.ts";
import type { WorkspaceFileSearchTarget } from "./chat-message-media-actions.ts";

export type ImageBlock = {
  factIndex?: number;
  fileName?: string;
  mimeType?: string;
  openUrl?: string;
  alt?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
} & ({ url: string; artifactId?: string } | { url?: undefined; artifactId: string });

export type ArtifactDownloadResolver = (
  params: {
    sessionKey: string;
    artifactId: string;
    variant?: "full" | "thumbnail";
    previewWidth?: ChatImageRenditionWidth;
  },
  signal?: AbortSignal,
) => Promise<{ url: string; expiresAt?: string; blob?: Blob } | null>;

export type ImageRenderOptions = {
  /** Navigation membership for an opened tile; sibling message ids keep their media scope. */
  galleryImages?: (image: ImageBlock) => {
    index: number;
    items: readonly { image: ImageBlock; messageId: string | undefined }[];
  };
  galleryVideos?: (item: AttachmentItem) => {
    index: number;
    items: readonly (AttachmentItem & { messageId?: string })[];
  };
  sessionKey?: string;
  messageId?: string;
  agentId?: string;
  policyKey?: string;
  canonicalMessageKey?: string;
  localSubmission?: boolean;
  messageSendId?: string;
  connectionEpoch?: number;
  resourceBasePath?: string;
  authToken?: string | null;
  /** Synchronous cancellation custody, independent of any rendering callback. */
  mediaOwner?: object;
  mediaReadAllowed?: boolean;
  /** A local resource observer; never a pane or page redraw callback. */
  onMediaChange?: () => void;
  onRequestOpenImage?: () => number;
  onOpenImage?: (item: ImageLightboxItem, requestVersion?: number) => void;
  /** Filename query only; the Files owner selects and authorizes any eventual file. */
  onFindWorkspaceFile?: (target: WorkspaceFileSearchTarget) => void;
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
  | "comment-preview"
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
  retainedImage?: HTMLImageElement;
  releaseAuthRecovery?: () => void;
};

type ChatMediaSubscriber = {
  resources: Map<string, ChatMediaResource<unknown>>;
  children: Set<object>;
  owner?: object;
  subscriber?: () => void;
};

type ManagedImageBlobUrl = {
  blob: Blob;
  url: string;
  retainCount: number;
};

const chatMediaResources = new Map<string, ChatMediaResource<unknown>>();
const chatMediaSubscribers = new Map<object, ChatMediaSubscriber>();
const managedImageBlobUrls = new Map<string, ManagedImageBlobUrl>();
const CHAT_MEDIA_CACHE_MAX_ENTRIES = 64;

function chatMediaResourceKey(kind: ChatMediaResourceKind, cacheKey: string): string {
  return `${kind}\0${cacheKey}`;
}

function getChatMediaSubscriber(subscriber: object): ChatMediaSubscriber {
  let state = chatMediaSubscribers.get(subscriber);
  if (!state) {
    state = { resources: new Map(), children: new Set() };
    chatMediaSubscribers.set(subscriber, state);
  }
  return state;
}

function pruneChatMediaSubscriber(subscriber: object, state: ChatMediaSubscriber): void {
  if (!state.owner && state.children.size === 0 && state.resources.size === 0) {
    chatMediaSubscribers.delete(subscriber);
  }
}

function removeChatMediaSubscriberChild(owner: object, subscriber: object): void {
  const state = chatMediaSubscribers.get(owner);
  if (state) {
    state.children.delete(subscriber);
    pruneChatMediaSubscriber(owner, state);
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
    // Offscreen virtual rows retain only settled, reusable resources.
    if (
      resource.retainUntil !== undefined &&
      resource.retainUntil > Date.now() &&
      !resource.discardWhenIdle &&
      !resource.pending
    ) {
      chatMediaResources.set(resourceKey, resource);
      trimChatMediaResources(
        (entry) => entry.retainUntil !== undefined && entry.subscribers.size === 0,
      );
    }
  }
  resource.abortController?.abort();
  resource.abortController = undefined;
}

export function readChatMediaResource<Value>(
  kind: ChatMediaResourceKind,
  cacheKey: string,
): ChatMediaResource<Value> | undefined {
  // SAFETY: Each namespaced key is created and read by the same typed resource owner.
  return chatMediaResources.get(chatMediaResourceKey(kind, cacheKey)) as
    | ChatMediaResource<Value>
    | undefined;
}

export function observeChatMediaResource<Value>(
  kind: ChatMediaResourceKind,
  cacheKey: string,
  subscriber?: () => void,
  subscriberScope = cacheKey,
  cacheScope?: string,
): ChatMediaResource<Value> {
  const resourceKey = chatMediaResourceKey(kind, cacheKey);
  let resource = readChatMediaResource<Value>(kind, cacheKey);
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
    const observation = getChatMediaSubscriber(subscriber);
    observation.subscriber = subscriber;
    const subscriptions = observation.resources;
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

function trimChatMediaResources(matches: (resource: ChatMediaResource<unknown>) => boolean) {
  const retained = [...chatMediaResources.entries()].filter(([, resource]) => matches(resource));
  for (const [resourceKey] of retained.slice(0, -CHAT_MEDIA_CACHE_MAX_ENTRIES)) {
    chatMediaResources.delete(resourceKey);
  }
}

export function isChatMediaResourceCurrent(resource: ChatMediaResource<unknown>): boolean {
  return (
    chatMediaResources.get(chatMediaResourceKey(resource.kind, resource.cacheKey)) === resource
  );
}

export function notifyChatMediaResourceSubscribers(resource: ChatMediaResource<unknown>) {
  if (!isChatMediaResourceCurrent(resource)) {
    return;
  }
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

export function scheduleChatMediaResourceRefresh(
  resource: ChatMediaResource<unknown>,
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
  resource.refresh = {
    at: refreshAt,
    timer: setTimeout(
      () => {
        resource.refresh = undefined;
        onRefresh();
      },
      Math.max(0, refreshAt - Date.now()),
    ),
  };
}

export function observeChatMediaResourceSubscriber(
  owner: object | undefined,
  subscriber: () => void,
) {
  const state = getChatMediaSubscriber(subscriber);
  if (state.owner === owner) {
    return;
  }
  if (state.owner) {
    removeChatMediaSubscriberChild(state.owner, subscriber);
  }
  if (owner) {
    getChatMediaSubscriber(owner).children.add(subscriber);
  }
  state.owner = owner;
}

export function releaseChatMediaResourceOwner(subscriber: object | undefined) {
  const state = subscriber && chatMediaSubscribers.get(subscriber);
  if (!subscriber || !state) {
    return;
  }
  chatMediaSubscribers.delete(subscriber);
  for (const child of state.children) {
    releaseChatMediaResourceOwner(child);
  }
  if (state.owner) {
    removeChatMediaSubscriberChild(state.owner, subscriber);
  }
  for (const resource of new Set(state.resources.values())) {
    if (state.subscriber) {
      detachChatMediaResourceSubscriber(resource, state.subscriber);
    }
  }
}

export function trimManagedImageMissResources() {
  trimChatMediaResources(
    (resource) =>
      resource.kind === "managed-image" &&
      resource.value === null &&
      resource.subscribers.size === 0 &&
      !resource.pending,
  );
}

export function readManagedImageBlobUrl(cacheKey: string): string | undefined {
  const cached = managedImageBlobUrls.get(cacheKey);
  if (cached) {
    managedImageBlobUrls.delete(cacheKey);
    managedImageBlobUrls.set(cacheKey, cached);
  }
  return cached?.url;
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
    cached.retainCount -= 1;
    trimManagedImageBlobUrlCache();
  };
}

export function cacheManagedImageBlob(cacheKey: string, blob: Blob): string {
  const blobUrl = URL.createObjectURL(blob);
  managedImageBlobUrls.set(cacheKey, {
    blob,
    url: blobUrl,
    retainCount: 0,
  });

  // Blob URLs retain browser-managed image data. Keep recent previews reusable,
  // but protect an image while its lightbox still uses that object URL.
  trimManagedImageBlobUrlCache();
  return blobUrl;
}

export function schedulePairingQrExpiryRefresh(
  messageKey: string,
  refreshAt: number | undefined,
  onMediaChange: (() => void) | undefined,
) {
  if (!onMediaChange) {
    return;
  }
  if (refreshAt === undefined) {
    const subscriber = chatMediaSubscribers.get(onMediaChange);
    const resourceKey = chatMediaResourceKey("pairing-qr", messageKey);
    const resource = subscriber?.resources.get(resourceKey);
    if (subscriber && resource) {
      subscriber.resources.delete(resourceKey);
      detachChatMediaResourceSubscriber(resource, onMediaChange);
      pruneChatMediaSubscriber(onMediaChange, subscriber);
    }
    return;
  }
  const resource = observeChatMediaResource<void>("pairing-qr", messageKey, onMediaChange);
  scheduleChatMediaResourceRefresh(resource, refreshAt, () =>
    notifyChatMediaResourceSubscribers(resource),
  );
}
