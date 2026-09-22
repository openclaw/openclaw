import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type {
  ArtifactsDownloadResult,
  ArtifactsListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthToken } from "../../app/control-ui-auth.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderChatImageLightbox } from "../chat/components/chat-image-lightbox.ts";
import { renderMessageImages } from "../chat/components/chat-message-images.ts";
import {
  assistantMediaPolicyKey,
  releaseChatMediaResourceSubscriber,
  type ImageBlock,
} from "../chat/components/chat-message-media.ts";
import "./session-activity-media.css";

registerActivityEnglish();

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

class ActivitySessionMedia extends OpenClawLightDomElement {
  @property({ attribute: false }) context!: ApplicationContext;
  @property() sessionKey = "";
  @property() agentId = "";
  @property({ type: Number }) revision = 0;
  @property({ attribute: false }) session?: GatewaySessionRow;

  private visible = false;
  private observer?: IntersectionObserver;
  private entry?: ImageEntry;
  private displayedImages: ImageBlock[] = [];
  private owner?: ConnectionImages;
  private key = "";
  private boundImageIdentity = "";
  private lightbox: ImageLightboxItem | null = null;
  private imageRequest = 0;
  private observedPending?: Promise<void>;
  private readonly refresh = () => this.requestUpdate();
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
  );

  override connectedCallback() {
    super.connectedCallback();
    // Visibility is required before transcript discovery; never fall back to an eager scan.
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        this.visible = entries.some((entry) => entry.isIntersecting);
        this.requestUpdate();
      },
      { rootMargin: "200px" },
    );
    this.observer.observe(this);
  }

  override disconnectedCallback() {
    this.observer?.disconnect();
    this.visible = false;
    this.subscriptions.clear();
    this.closeImage();
    releaseChatMediaResourceSubscriber(this.refresh);
    super.disconnectedCallback();
  }

  private closeImage = () => {
    this.imageRequest++;
    this.lightbox?.release?.();
    this.lightbox = null;
    this.requestUpdate();
  };

  private get imageIdentity(): string {
    return JSON.stringify([
      this.agentId,
      this.sessionKey,
      this.session?.sessionId,
      assistantMediaPolicyKey(this.session),
    ]);
  }

  override willUpdate() {
    const { client, hello, phase } = this.context.gateway.snapshot;
    const owner = client && phase === "connected" ? connectionImages(client, hello) : undefined;
    const key = JSON.stringify([
      this.agentId,
      this.sessionKey,
      this.session?.sessionId,
      this.revision,
    ]);
    const imageIdentity = this.imageIdentity;
    if (owner !== this.owner || imageIdentity !== this.boundImageIdentity) {
      this.displayedImages = [];
      this.closeImage();
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
    if (
      this.entry?.loaded &&
      !this.entry.pending &&
      (!this.entry.error || this.displayedImages.length === 0)
    ) {
      this.displayedImages = this.entry.images.slice(0, 4);
    }
  }

  private load = () => {
    const gateway = this.context.gateway;
    const { client, hello } = gateway.snapshot;
    const owner = this.owner;
    const entry = this.entry;
    const key = this.key;
    const sessionKey = this.sessionKey;
    const agentId = this.agentId;
    if (!client || !owner || !entry || entry.pending) {
      return;
    }
    const current = () =>
      this.isConnected &&
      this.visible &&
      this.owner === owner &&
      this.key === key &&
      gateway.snapshot.client === client &&
      gateway.snapshot.hello === hello &&
      gateway.snapshot.phase === "connected";
    if (entry.error) {
      entry.cursor = undefined;
      entry.images = [];
    }
    entry.error = false;
    entry.pending = queued(owner, JSON.stringify([agentId, sessionKey]), async () => {
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
            if (
              artifact.image &&
              !entry.images.some((image) => image.url === artifact.image?.url)
            ) {
              entry.images.push({
                url: artifact.image.url,
                artifactId:
                  artifact.source === "session-transcript-preview" ? undefined : artifact.id,
                alt: artifact.title,
              });
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
        this.requestUpdate();
      });
    this.requestUpdate();
  };

  override render() {
    const entry = this.entry;
    const owner = this.owner;
    const gateway = this.context.gateway;
    const { client, hello } = gateway.snapshot;
    if (!entry || !owner || !client) {
      return nothing;
    }
    const showMedia =
      this.displayedImages.length > 0 || entry.error || entry.cursor || entry.omitted;
    const imageIdentity = this.imageIdentity;
    const agentId = this.agentId;
    return html`
      ${
        showMedia
          ? html`<div class="activity-feed__media">
              ${renderMessageImages(this.displayedImages, {
                sessionKey: this.sessionKey,
                agentId: this.agentId,
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
                onOpenImage: (item, version) => {
                  if (
                    !this.isConnected ||
                    this.owner !== owner ||
                    this.imageIdentity !== imageIdentity ||
                    gateway.snapshot.client !== client ||
                    gateway.snapshot.hello !== hello ||
                    gateway.snapshot.phase !== "connected" ||
                    version !== this.imageRequest
                  ) {
                    item.release?.();
                    return;
                  }
                  this.lightbox?.release?.();
                  this.lightbox = item;
                  this.requestUpdate();
                },
                resolveArtifactDownload: async (params) => {
                  const result = await client.request<ArtifactsDownloadResult>(
                    "artifacts.download",
                    {
                      ...params,
                      agentId,
                    },
                  );
                  return gateway.snapshot.client === client &&
                    gateway.snapshot.hello === hello &&
                    gateway.snapshot.phase === "connected" &&
                    result.url
                    ? { url: result.url, expiresAt: result.expiresAt }
                    : null;
                },
              })}
              ${entry.error ? html`<span role="status">${t("activity.images.failed")}</span><button class="btn btn--sm" @click=${this.load}>${t("common.retry")}</button>` : nothing}
              ${entry.cursor && entry.images.length < 4 && !entry.error ? html`<button class="btn btn--sm" ?disabled=${Boolean(entry.pending)} @click=${this.load}>${entry.pending ? t("common.loading") : t("activity.images.older")}</button>` : nothing}
              ${entry.omitted ? html`<span class="activity-feed__media-note">${t("activity.images.incomplete")}</span>` : nothing}
            </div>`
          : nothing
      }
      ${renderChatImageLightbox(this.lightbox, this.closeImage)}
    `;
  }
}

if (!customElements.get("openclaw-activity-session-media")) {
  customElements.define("openclaw-activity-session-media", ActivitySessionMedia);
}
