import { html } from "lit";
import { createRenderEffect, createSignal, onCleanup, onSettled } from "solid-js";
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
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { LitContent } from "../../lit/solid-content.tsx";
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

// The cache and admission owner stays synchronous; Solid only observes its presentation.
class ActivitySessionMediaState {
  visible = false;
  private observer?: IntersectionObserver;
  private entry?: ImageEntry;
  private settledEntry?: ImageEntry;
  displayedImages: ImageBlock[] = [];
  owner?: ConnectionImages;
  private key = "";
  private boundImageIdentity = "";
  lightbox: ImageLightboxItem | null = null;
  private imageRequest = 0;
  private observedPending?: Promise<void>;
  private disposed = false;

  constructor(
    readonly props: ActivitySessionMediaProps,
    private readonly host: HTMLElement,
    private readonly notify: () => void,
  ) {}

  private get context() {
    return this.props.context;
  }
  private get sessionKey() {
    return this.props.sessionKey;
  }
  private get agentId() {
    return this.props.agentId;
  }
  private get revision() {
    return this.props.revision;
  }
  private get session() {
    return this.props.session;
  }
  private get isConnected() {
    return !this.disposed && this.host.isConnected;
  }

  readonly refresh = () => {
    if (!this.disposed) {
      this.synchronize();
      this.notify();
    }
  };

  connect() {
    // Visibility is required before transcript discovery; never fall back to an eager scan.
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        this.visible = entries.some((entry) => entry.isIntersecting);
        this.refresh();
      },
      { rootMargin: "200px" },
    );
    this.observer.observe(this.host);
  }

  dispose() {
    this.disposed = true;
    this.observer?.disconnect();
    this.visible = false;
    this.closeImage(false);
    releaseChatMediaResourceSubscriber(this.refresh);
  }

  readonly closeImage = (notify = true) => {
    this.imageRequest++;
    this.lightbox?.release?.();
    this.lightbox = null;
    if (notify) {
      this.refresh();
    }
  };

  private get imageIdentity(): string {
    return JSON.stringify([
      this.agentId,
      this.sessionKey,
      this.session?.sessionId,
      assistantMediaPolicyKey(this.session),
    ]);
  }

  synchronize() {
    const { client, hello, phase } = this.context.gateway.snapshot;
    const owner = client && phase === "connected" ? connectionImages(client, hello) : undefined;
    const imageIdentity = this.imageIdentity;
    const key = JSON.stringify([imageIdentity, this.revision]);
    if (owner !== this.owner || imageIdentity !== this.boundImageIdentity) {
      this.settledEntry = undefined;
      this.displayedImages = [];
      this.closeImage(false);
      releaseChatMediaResourceSubscriber(this.refresh);
      this.boundImageIdentity = imageIdentity;
    }
    if (owner !== this.owner || key !== this.key) {
      this.owner = owner;
      this.key = key;
      this.entry = undefined;
      if (owner) {
        this.entry = owner.entries.get(key);
        if (!this.entry) {
          this.entry = { images: [], loaded: false };
          owner.entries.set(key, this.entry);
          if (owner.entries.size > 128) {
            const oldest = owner.entries.keys().next().value;
            if (oldest) {
              owner.entries.delete(oldest);
            }
          }
        }
      }
    }
    if (this.visible && this.entry && !this.entry.loaded && !this.entry.pending) {
      this.load();
    }
    if (this.entry?.pending && this.observedPending !== this.entry.pending) {
      this.observedPending = this.entry.pending;
      void this.observedPending.then(this.refresh);
    }
    if (this.entry?.loaded && !this.entry.pending) {
      this.settledEntry = this.entry;
    }
    const settled = this.settledEntry;
    if (settled && !settled.pending && (!settled.error || this.displayedImages.length === 0)) {
      this.displayedImages = settled.images.slice(0, 4);
    }
  }

  readonly load = (entry = this.entry) => {
    const gateway = this.context.gateway;
    const { client, hello } = gateway.snapshot;
    const owner = this.owner;
    const imageIdentity = this.imageIdentity;
    const sessionKey = this.sessionKey;
    const agentId = this.agentId;
    if (!client || !owner || !entry || entry.pending) {
      return;
    }
    const current = () =>
      this.isConnected &&
      this.visible &&
      this.owner === owner &&
      this.imageIdentity === imageIdentity &&
      (this.entry === entry || this.settledEntry === entry) &&
      gateway.snapshot.client === client &&
      gateway.snapshot.hello === hello &&
      gateway.snapshot.phase === "connected";
    if (entry.error) {
      entry.cursor = undefined;
      entry.images = [];
    }
    entry.error = false;
    // Explicit pagination must not supersede a queued background refresh.
    const queueKey = JSON.stringify([agentId, sessionKey, entry === this.settledEntry]);
    entry.pending = queued(owner, queueKey, async () => {
      try {
        // A viewport visit searches at most three bounded pages. Older history is explicit.
        for (let page = 0; page < 3 && entry.images.length < 4 && current(); page++) {
          const result = await client.request<ArtifactsListResult>("artifacts.list", {
            sessionKey,
            agentId,
            type: "image",
            limit: 4 - entry.images.length,
            ...(entry.cursor ? { cursor: entry.cursor } : {}),
          });
          if (!current()) {
            return;
          }
          entry.loaded = true;
          entry.cursor = result.nextCursor;
          entry.omitted ||= result.omittedOversized;
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
              !entry.images.some(
                (existing) =>
                  (existing.url ?? existing.artifactId) === (image.url ?? image.artifactId),
              )
            ) {
              entry.images.push(image);
            }
          }
          if (!entry.cursor) {
            break;
          }
        }
      } catch {
        if (current()) {
          entry.loaded = true;
          entry.error = true;
        }
      }
    })
      .then((admission) => {
        if (admission !== "run" && current()) {
          entry.loaded = true;
          entry.error = admission === "full";
        }
      })
      .finally(() => {
        entry.pending = undefined;
        this.refresh();
      });
    this.refresh();
  };

  get displayEntry() {
    const { client } = this.context.gateway.snapshot;
    return this.owner && client ? (this.settledEntry ?? this.entry) : undefined;
  }

  imageOptions() {
    const owner = this.owner!;
    const gateway = this.context.gateway;
    const { client, hello } = gateway.snapshot;
    const currentConnection = () =>
      gateway.snapshot.client === client &&
      gateway.snapshot.hello === hello &&
      gateway.snapshot.phase === "connected";
    const imageIdentity = this.imageIdentity;
    const agentId = this.agentId;
    return {
      sessionKey: this.sessionKey,
      agentId,
      connectionEpoch: owner.epoch,
      policyKey: assistantMediaPolicyKey(this.session),
      resourceBasePath: this.context.resourceBasePath,
      authToken: resolveControlUiAuthToken({
        hello,
        settings: { token: gateway.connection.token },
        password: gateway.connection.password,
      }),
      onRequestUpdate: this.refresh,
      onRequestOpenImage: () => ++this.imageRequest,
      onOpenImage: (item: ImageLightboxItem, version?: number) => {
        if (
          !this.isConnected ||
          this.owner !== owner ||
          this.imageIdentity !== imageIdentity ||
          !currentConnection() ||
          version !== this.imageRequest
        ) {
          item.release?.();
          return;
        }
        this.lightbox?.release?.();
        this.lightbox = item;
        this.refresh();
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
            resourceBasePath: this.context.resourceBasePath,
          },
          { ...params, agentId },
          signal,
        ),
    };
  }
}

function ActivitySessionMediaContent(
  props: ActivitySessionMediaProps,
  host: SolidBridgeElement<ActivitySessionMediaProps>,
) {
  const [revision, setRevision] = createSignal(0);
  const state = new ActivitySessionMediaState(props, host, () => setRevision((value) => value + 1));
  const gateway = projectGateway(props.context.gateway);
  createRenderEffect(
    () => props.context.gateway,
    (source) => gateway.replaceSource(source),
  );
  createRenderEffect(
    () => [gateway.read(), props.sessionKey, props.agentId, props.revision, props.session],
    () => state.refresh(),
  );
  onSettled(() => state.connect());
  onCleanup(() => state.dispose());
  const entry = () => {
    revision();
    return state.displayEntry;
  };
  const hasImages = () => {
    revision();
    return state.displayedImages.length > 0;
  };
  const older = () => {
    const value = entry();
    return Boolean(value?.cursor && value.images.length < 4 && !value.error);
  };
  const showNote = () => {
    const value = entry();
    return Boolean(value?.error || value?.omitted || (!hasImages() && value?.cursor));
  };
  const load = () => state.load(entry());
  const loadLabel = () => t(entry()?.pending ? "common.loading" : "activity.images.older");
  const gallery = () => {
    revision();
    // The unported chat gallery owns these children and its resource directives.
    const previews = older()
      ? [
          html`<button
            class="activity-feed__note-action"
            ?disabled=${Boolean(entry()?.pending)}
            @click=${() => state.load(entry())}
          >
            ${loadLabel()}
          </button>`,
        ]
      : [];
    return renderMessageImages(state.displayedImages, state.imageOptions(), previews);
  };
  const lightbox = () => {
    revision();
    return renderChatImageLightbox(state.lightbox, () => state.closeImage());
  };
  return (
    <>
      {(hasImages() || showNote()) && (
        <div class="activity-feed__media">
          {hasImages() && <LitContent content={gallery()} />}
          {showNote() && (
            <div class="activity-feed__note">
              {entry()?.omitted && <span>{t("activity.images.incomplete")}</span>}
              {entry()?.error ? (
                <>
                  <span role="status">{t("activity.images.failed")}</span>
                  <button
                    class="activity-feed__note-action"
                    disabled={Boolean(entry()?.pending)}
                    onClick={load}
                  >
                    {t("common.retry")}
                  </button>
                </>
              ) : (
                !hasImages() &&
                older() && (
                  <button
                    class="activity-feed__note-action"
                    disabled={Boolean(entry()?.pending)}
                    onClick={load}
                  >
                    {loadLabel()}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      )}
      <LitContent content={lightbox()} />
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
