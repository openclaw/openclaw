import { createEffect, createSignal, onCleanup, onSettled, untrack } from "solid-js";
import type { ArtifactsListResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { resolveArtifactDownloadSource } from "../../api/artifact-download.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge, LitContent, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { renderChatImageLightbox } from "../chat/components/chat-image-lightbox.ts";
import { renderMessageImages } from "../chat/components/chat-message-images.ts";
import {
  assistantMediaPolicyKey,
  releaseChatMediaResourceSubscriber,
  type ImageBlock,
} from "../chat/components/chat-message-media.ts";
import "./session-activity-media.css";

registerEnglishCatalog(registerActivityEnglish);

type ImageEntry = {
  images: ImageBlock[];
  loaded: boolean;
  pending?: Promise<void>;
  cursor?: string;
  error?: boolean;
  omitted?: boolean;
};
type ImageQueueAdmission = "run" | "superseded" | "full";
type ConnectionImages = {
  hello: GatewayHelloOk | null;
  epoch: number;
  entries: Map<string, ImageEntry>;
  running: number;
  queue: Array<{ key: string; admit: (result: ImageQueueAdmission) => void }>;
};
const connections = new WeakMap<GatewayBrowserClient, ConnectionImages>();
let connectionEpoch = 0;

function connectionImages(
  client: GatewayBrowserClient,
  hello: GatewayHelloOk | null,
): ConnectionImages {
  let state = connections.get(client);
  if (!state || state.hello !== hello) {
    state = { hello, epoch: ++connectionEpoch, entries: new Map(), running: 0, queue: [] };
    connections.set(client, state);
  }
  return state;
}

async function queued(state: ConnectionImages, key: string, run: () => Promise<void>) {
  if (state.running >= 2) {
    const admission = await new Promise<ImageQueueAdmission>((admit) => {
      const index = state.queue.findIndex((entry) => entry.key === key);
      const previous = state.queue[index];
      if (previous) {
        state.queue[index] = { key, admit };
        previous.admit("superseded");
      } else if (state.queue.length < 128) {
        state.queue.push({ key, admit });
      } else {
        admit("full");
      }
    });
    if (admission !== "run") {
      return admission;
    }
  } else {
    state.running++;
  }
  try {
    await run();
    return "run";
  } finally {
    const next = state.queue.shift();
    if (next) {
      next.admit("run");
    } else {
      state.running--;
    }
  }
}

export type ActivitySessionMediaProps = {
  context: ApplicationContext;
  sessionKey: string;
  agentId: string;
  revision: number;
  session?: GatewaySessionRow;
};

function ActivitySessionMediaContent(
  props: ActivitySessionMediaProps,
  host: SolidBridgeElement<ActivitySessionMediaProps>,
) {
  const [revision, setRevision] = createSignal(0);
  let visible = false;
  let observer: IntersectionObserver | undefined;
  let entry: ImageEntry | undefined;
  let settledEntry: ImageEntry | undefined;
  let displayedImages: ImageBlock[] = [];
  let owner: ConnectionImages | undefined;
  let key = "";
  let boundImageIdentity = "";
  let lightbox: ImageLightboxItem | null = null;
  let imageRequest = 0;
  let observedPending: Promise<void> | undefined;
  let disposed = false;

  const isConnected = () => !disposed && host.isConnected;

  const refresh = () => {
    if (!disposed) {
      synchronize();
      setRevision((value) => value + 1);
    }
  };

  function connect() {
    // Visibility is required before transcript discovery; never fall back to an eager scan.
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((observation) => observation.isIntersecting);
        refresh();
      },
      { rootMargin: "200px" },
    );
    observer.observe(host);
  }

  function dispose() {
    disposed = true;
    observer?.disconnect();
    visible = false;
    closeImage(false);
    releaseChatMediaResourceSubscriber(refresh);
  }

  const closeImage = (notify = true) => {
    imageRequest++;
    lightbox?.release?.();
    lightbox = null;
    if (notify) {
      refresh();
    }
  };

  function imageIdentity(): string {
    return JSON.stringify([
      props.agentId,
      props.sessionKey,
      props.session?.sessionId,
      assistantMediaPolicyKey(props.session),
    ]);
  }

  function synchronize() {
    const { client, hello, phase } = props.context.gateway.snapshot;
    const nextOwner = client && phase === "connected" ? connectionImages(client, hello) : undefined;
    const identity = imageIdentity();
    const nextKey = JSON.stringify([identity, props.revision]);
    if (nextOwner !== owner || identity !== boundImageIdentity) {
      settledEntry = undefined;
      displayedImages = [];
      closeImage(false);
      releaseChatMediaResourceSubscriber(refresh);
      boundImageIdentity = identity;
    }
    if (nextOwner !== owner || nextKey !== key) {
      owner = nextOwner;
      key = nextKey;
      entry = undefined;
      if (owner) {
        entry = owner.entries.get(key);
        if (!entry) {
          entry = { images: [], loaded: false };
          owner.entries.set(key, entry);
          if (owner.entries.size > 128) {
            const oldest = owner.entries.keys().next().value;
            if (oldest) {
              owner.entries.delete(oldest);
            }
          }
        }
      }
    }
    if (visible && entry && !entry.loaded && !entry.pending) {
      load();
    }
    if (entry?.pending && observedPending !== entry.pending) {
      observedPending = entry.pending;
      void observedPending.then(refresh);
    }
    if (entry?.loaded && !entry.pending) {
      settledEntry = entry;
    }
    const settled = settledEntry;
    if (settled && !settled.pending && (!settled.error || displayedImages.length === 0)) {
      displayedImages = settled.images.slice(0, 4);
    }
  }

  const load = (target = entry) => {
    const gateway = props.context.gateway;
    const { client, hello } = gateway.snapshot;
    const requestOwner = owner;
    const identity = imageIdentity();
    const sessionKey = props.sessionKey;
    const agentId = props.agentId;
    if (!client || !requestOwner || !target || target.pending) {
      return;
    }
    const current = () =>
      isConnected() &&
      visible &&
      owner === requestOwner &&
      imageIdentity() === identity &&
      (entry === target || settledEntry === target) &&
      gateway.snapshot.client === client &&
      gateway.snapshot.hello === hello &&
      gateway.snapshot.phase === "connected";
    if (target.error) {
      target.cursor = undefined;
      target.images = [];
    }
    target.error = false;
    // Explicit pagination must not supersede a queued background refresh.
    const queueKey = JSON.stringify([agentId, sessionKey, target === settledEntry]);
    target.pending = queued(requestOwner, queueKey, async () => {
      try {
        // A viewport visit searches at most three bounded pages. Older history is explicit.
        for (let page = 0; page < 3 && target.images.length < 4 && current(); page++) {
          const result = await client.request<ArtifactsListResult>("artifacts.list", {
            sessionKey,
            agentId,
            type: "image",
            limit: 4 - target.images.length,
            ...(target.cursor ? { cursor: target.cursor } : {}),
          });
          if (!current()) {
            return;
          }
          target.loaded = true;
          target.cursor = result.nextCursor;
          target.omitted ||= result.omittedOversized;
          for (const artifact of result.artifacts) {
            const image: ImageBlock | undefined = artifact.image?.url
              ? {
                  url: artifact.image.url,
                  artifactId:
                    artifact.source === "session-transcript-preview" ? undefined : artifact.id,
                  alt: artifact.title,
                }
              : artifact.type === "image" && artifact.download.mode !== "unsupported"
                ? { artifactId: artifact.id, alt: artifact.title }
                : undefined;
            if (
              image &&
              !target.images.some(
                (existing) =>
                  (existing.url ?? existing.artifactId) === (image.url ?? image.artifactId),
              )
            ) {
              target.images.push(image);
            }
          }
          if (!target.cursor) {
            break;
          }
        }
      } catch {
        if (current()) {
          target.loaded = true;
          target.error = true;
        }
      }
    })
      .then((admission) => {
        if (admission !== "run" && current()) {
          target.loaded = true;
          target.error = admission === "full";
        }
      })
      .finally(() => {
        target.pending = undefined;
        refresh();
      });
    refresh();
  };

  function imageOptions() {
    const imageOwner = owner!;
    const gateway = props.context.gateway;
    const { client, hello } = gateway.snapshot;
    const currentConnection = () =>
      gateway.snapshot.client === client &&
      gateway.snapshot.hello === hello &&
      gateway.snapshot.phase === "connected";
    const identity = imageIdentity();
    const agentId = props.agentId;
    return {
      sessionKey: props.sessionKey,
      agentId,
      connectionEpoch: imageOwner.epoch,
      policyKey: assistantMediaPolicyKey(props.session),
      resourceBasePath: props.context.resourceBasePath,
      authToken: resolveControlUiAuthToken({
        hello,
        settings: { token: gateway.connection.token },
        password: gateway.connection.password,
      }),
      onRequestUpdate: refresh,
      onRequestOpenImage: () => ++imageRequest,
      onOpenImage: (item: ImageLightboxItem, version?: number) => {
        if (
          !isConnected() ||
          owner !== imageOwner ||
          imageIdentity() !== identity ||
          !currentConnection() ||
          version !== imageRequest
        ) {
          item.release?.();
          return;
        }
        lightbox?.release?.();
        lightbox = item;
        refresh();
      },
      resolveArtifactDownload: (
        params: Parameters<typeof resolveArtifactDownloadSource>[1],
        signal?: AbortSignal,
      ) =>
        resolveArtifactDownloadSource(
          {
            get client() {
              return gateway.snapshot.client;
            },
            get connected() {
              return currentConnection();
            },
            resourceBasePath: props.context.resourceBasePath,
          },
          { ...params, agentId },
          signal,
        ),
    };
  }
  // The projection is seeded once; its source follows the tracked effect below.
  const gatewayProjection = projectGateway(untrack(() => props.context.gateway));
  createEffect(
    () => props.context.gateway,
    (source) => gatewayProjection.replaceSource(source),
  );
  createEffect(
    () => [
      gatewayProjection.read(),
      props.sessionKey,
      props.agentId,
      props.revision,
      props.session,
    ],
    () => untrack(refresh),
  );
  onSettled(connect);
  onCleanup(dispose);
  const displayEntry = () => {
    revision();
    return owner && props.context.gateway.snapshot.client ? (settledEntry ?? entry) : undefined;
  };
  const hasImages = () => {
    revision();
    return displayedImages.length > 0;
  };
  const older = () => {
    const value = displayEntry();
    return Boolean(value?.cursor && value.images.length < 4 && !value.error);
  };
  const showNote = () => {
    const value = displayEntry();
    return Boolean(value?.error || value?.omitted || (!hasImages() && value?.cursor));
  };
  const loadDisplayed = () => load(displayEntry());
  const loadLabel = () => t(displayEntry()?.pending ? "common.loading" : "activity.images.older");
  const olderButton = (
    <button
      class="activity-feed__note-action"
      disabled={Boolean(displayEntry()?.pending)}
      onClick={loadDisplayed}
    >
      {loadLabel()}
    </button>
  );
  const gallery = () => {
    revision();
    // The unported chat gallery owns these children and its resource directives.
    const previews = older() ? [olderButton] : [];
    return renderMessageImages(displayedImages, imageOptions(), previews);
  };
  const lightboxContent = () => {
    revision();
    return renderChatImageLightbox(lightbox, () => closeImage());
  };
  return (
    <>
      {(hasImages() || showNote()) && (
        <div class="activity-feed__media">
          {hasImages() && <LitContent render={gallery} />}
          {showNote() && (
            <div class="activity-feed__note">
              {displayEntry()?.omitted && <span>{t("activity.images.incomplete")}</span>}
              {displayEntry()?.error && <span role="status">{t("activity.images.failed")}</span>}
              {(displayEntry()?.error || (!hasImages() && older())) && (
                <button
                  class="activity-feed__note-action"
                  disabled={Boolean(displayEntry()?.pending)}
                  onClick={loadDisplayed}
                >
                  {displayEntry()?.error ? t("common.retry") : loadLabel()}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      <LitContent render={lightboxContent} />
    </>
  );
}

export const ActivitySessionMedia = defineSolidBridge<ActivitySessionMediaProps>(
  "openclaw-activity-session-media",
  ActivitySessionMediaContent,
  {
    properties: {
      context: { default: undefined!, attribute: false },
      sessionKey: { default: "" },
      agentId: { default: "" },
      revision: { default: 0, type: Number },
      session: { default: undefined, attribute: false },
    },
  },
);
