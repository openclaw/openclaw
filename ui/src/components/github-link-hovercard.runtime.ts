import { initialState, Task, TaskStatus } from "@lit/task";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { nothing, ReactiveElement, render } from "lit";
import type { ControlUiGitHubPreview } from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import { subscribeToSharedRequest } from "../lib/shared-request-subscription.ts";
import "../styles/github-link-hovercard.css";
import {
  previewState,
  renderGitHubPreview,
  renderGitHubPreviewLoading,
  type GitHubPreview,
} from "./github-link-hovercard-view.ts";
import {
  GITHUB_HOVERCARD_OPEN_DELAY_MS,
  githubLinkAnchorFromEvent,
  gitHubPreviewKey,
  parseGitHubLinkTarget,
  type GitHubLinkTarget,
} from "./github-link-target.ts";
import { createPortaledHovercard, PortaledHovercardController } from "./portaled-hovercard.ts";

const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 100;

type CacheEntry = {
  preview?: ControlUiGitHubPreview;
  failed?: boolean;
  expiresAt: number;
  promise: Promise<ControlUiGitHubPreview>;
  controller: AbortController;
  subscribers: Set<object>;
};

type PreviewContext = {
  generation: number;
  recoveryScope: string;
  succeeded: boolean;
};

// Page-memory only. Providers share success, never credentials or persisted state.
const previewContexts = new WeakMap<GatewayBrowserClient, Map<string, PreviewContext>>();

function previewContextFor(
  client: GatewayBrowserClient,
  agentId: string | undefined,
): PreviewContext {
  let contexts = previewContexts.get(client);
  if (!contexts) {
    contexts = new Map();
    previewContexts.set(client, contexts);
  }
  const key = agentId ?? "";
  let context = contexts.get(key);
  if (
    !context ||
    context.generation !== client.connectionGeneration ||
    context.recoveryScope !== client.recoveryScope
  ) {
    context = {
      generation: client.connectionGeneration,
      recoveryScope: client.recoveryScope,
      succeeded: false,
    };
    contexts.set(key, context);
  }
  return context;
}

let nextHovercardId = 0;

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = readNonBlankString(record[key]);
  if (value === undefined) {
    throw new Error(`GitHub response omitted ${key}`);
  }
  return value;
}

function safeAvatarDataUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^data:image\/(?:gif|jpeg|png|webp);base64,/u.test(value)
    ? value
    : undefined;
}

/** Gateway data is untrusted here: keep only well-formed logins and inlined avatars. */
function parseCoAuthors(value: unknown): { login: string; avatarDataUrl?: string }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const login = readNonBlankString(entry.login);
    if (!login) {
      return [];
    }
    const avatarDataUrl = safeAvatarDataUrl(entry.avatarDataUrl);
    return [avatarDataUrl ? { login, avatarDataUrl } : { login }];
  });
  return parsed.length > 0 ? parsed : undefined;
}

function parsePreviewResponse(target: GitHubLinkTarget, value: unknown): ControlUiGitHubPreview {
  if (!isRecord(value)) {
    throw new Error("GitHub response was not an object");
  }
  if (
    value.kind !== target.kind ||
    typeof value.owner !== "string" ||
    value.owner.toLowerCase() !== target.owner.toLowerCase() ||
    typeof value.repo !== "string" ||
    value.repo.toLowerCase() !== target.repo.toLowerCase() ||
    value.number !== target.number
  ) {
    throw new Error("GitHub response did not match the requested link");
  }
  return {
    additions: asFiniteNumber(value.additions),
    avatarDataUrl: safeAvatarDataUrl(value.avatarDataUrl),
    closedAt: readNonBlankString(value.closedAt),
    coAuthorCount: asFiniteNumber(value.coAuthorCount),
    coAuthors: parseCoAuthors(value.coAuthors),
    comments: asFiniteNumber(value.comments),
    createdAt: requiredString(value, "createdAt"),
    deletions: asFiniteNumber(value.deletions),
    draft: typeof value.draft === "boolean" ? value.draft : undefined,
    kind: target.kind,
    login: readNonBlankString(value.login) ?? "ghost",
    mergedAt: readNonBlankString(value.mergedAt),
    number: target.number,
    owner: target.owner,
    repo: target.repo,
    state: requiredString(value, "state"),
    stateReason: readNonBlankString(value.stateReason),
    title: requiredString(value, "title"),
    updatedAt: requiredString(value, "updatedAt"),
  };
}

export class GitHubLinkHovercardProvider extends ReactiveElement {
  // Lit must replay values assigned before the lazy custom element upgrades,
  // otherwise own properties shadow the identity-resetting accessors below.
  static override properties = {
    client: { attribute: false, noAccessor: true },
    agentId: { attribute: false, noAccessor: true },
    previewSeeds: { attribute: false, noAccessor: true },
  };

  private gatewayClient: GatewayBrowserClient | null = null;
  private selectedAgentId: string | undefined;
  private seeds: {
    client: GatewayBrowserClient | null;
    agentId: string | undefined;
    generation: number | undefined;
    recoveryScope: string | undefined;
    previews: readonly GitHubPreview[];
  } | null = null;

  get previewSeeds(): readonly GitHubPreview[] {
    return this.seeds?.previews ?? [];
  }

  set previewSeeds(previews: readonly GitHubPreview[]) {
    this.seeds = {
      client: this.client,
      agentId: this.agentId,
      generation: this.client?.connectionGeneration,
      recoveryScope: this.client?.recoveryScope,
      previews,
    };
    this.requestUpdate();
  }

  private seedPreview(target: GitHubLinkTarget): GitHubPreview | undefined {
    const seeds = this.seeds;
    if (
      !seeds ||
      seeds.client !== this.client ||
      seeds.agentId !== this.agentId ||
      seeds.generation !== this.client?.connectionGeneration ||
      seeds.recoveryScope !== this.client?.recoveryScope
    ) {
      return undefined;
    }
    const seed = seeds.previews.find(
      (preview) => gitHubPreviewKey(preview) === gitHubPreviewKey(target),
    );
    return seed ? { ...seed, ...target } : undefined;
  }

  get client(): GatewayBrowserClient | null {
    return this.gatewayClient;
  }

  set client(value: GatewayBrowserClient | null) {
    if (value === this.gatewayClient) {
      return;
    }
    this.invalidatePreviewContext();
    this.close();
    this.clearPreviews();
    this.gatewayClient = value;
  }

  get agentId(): string | undefined {
    return this.selectedAgentId;
  }

  set agentId(value: string | undefined) {
    if (value === this.selectedAgentId) {
      return;
    }
    this.invalidatePreviewContext();
    this.close();
    this.clearPreviews();
    this.selectedAgentId = value;
  }

  private readonly cache = new Map<string, CacheEntry>();
  private previewContext: PreviewContext | null = null;
  private allowLoading = false;
  private requestStarted = false;

  private invalidatePreviewContext(): void {
    this.seeds = null;
    this.previewContext = null;
  }

  private syncPreviewContext(): PreviewContext | null {
    const context = this.client ? previewContextFor(this.client, this.agentId) : null;
    if (context !== this.previewContext) {
      // Clearing cached facts also updates inline projections under this new context.
      this.previewContext = context;
      this.close();
      this.clearPreviews();
    }
    return context;
  }
  private syncInlineStates(): void {
    this.syncPreviewContext();
    for (const anchor of this.querySelectorAll<HTMLAnchorElement>("a.markdown-github-item")) {
      // Nested providers retain their own agent and connection identity.
      let owner = anchor.parentElement;
      while (owner && !(owner instanceof GitHubLinkHovercardProvider)) {
        owner = owner.parentElement;
      }
      if (owner !== this) {
        continue;
      }
      const target = parseGitHubLinkTarget(anchor.href);
      const preview = target ? this.cachedPreview(target)?.preview : undefined;
      if (!preview) {
        delete anchor.dataset.githubState;
        anchor.removeAttribute("aria-description");
      } else {
        const state = previewState(preview);
        anchor.setAttribute("aria-description", state.label);
        anchor.dataset.githubState = state.state;
      }
    }
  }

  private readonly inlineObserver = new MutationObserver(() => this.syncInlineStates());

  private clearPreviews(): void {
    for (const entry of this.cache.values()) {
      entry.controller.abort();
    }
    this.cache.clear();
    this.syncInlineStates();
  }

  async prefetch(target: GitHubLinkTarget, signal: AbortSignal): Promise<void> {
    if (!this.isConnected || !this.client?.connected || signal.aborted) {
      return;
    }
    this.syncPreviewContext();
    await this.loadPreview(target, signal);
    if (!signal.aborted) {
      this.syncInlineStates();
    }
  }

  private activeAnchor: HTMLAnchorElement | null = null;
  private activeTarget: GitHubLinkTarget | null = null;
  // Which surface opened the current card: gates whether focus landing inside
  // the portaled card (e.g. clicking the title link) can hold it open, so a
  // pointer-driven open still fully releases on mouse-out (see handleCardPointerLeave).
  private activeTrigger: "focus" | "pointer" | null = null;
  private readonly hovercard = new PortaledHovercardController(() => this.close());
  private stopI18n: (() => void) | null = null;
  private readonly previewTask = new Task(this, {
    autoRun: false,
    args: () => [this.activeTarget] as const,
    // Share metadata, not navigation: each activation owns its full validated URL.
    task: async ([target], { signal }) =>
      target ? { ...(await this.loadPreview(target, signal)), ...target } : initialState,
  });
  private readonly activeAnchorObserver = new MutationObserver(() => {
    const anchor = this.activeAnchor;
    // The card is portaled outside the routed tree, whose replacement can remove
    // a hovered link without a pointer event reaching this delegated handler.
    if (anchor && (!this.contains(anchor) || anchor.href !== this.activeTarget?.href)) {
      this.close();
    }
  });

  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = "contents";
    this.inlineObserver.observe(this, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    this.addEventListener("pointerover", this.handlePointerOver);
    this.addEventListener("pointerout", this.handlePointerOut);
    this.addEventListener("focusin", this.handleFocusIn);
    this.addEventListener("focusout", this.handleFocusOut);
    this.addEventListener("keydown", this.hovercard.handleTriggerKeyDown);
    this.addEventListener("click", this.handleClick);
    this.stopI18n ??= i18n.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    this.removeEventListener("pointerover", this.handlePointerOver);
    this.removeEventListener("pointerout", this.handlePointerOut);
    this.removeEventListener("focusin", this.handleFocusIn);
    this.removeEventListener("focusout", this.handleFocusOut);
    this.removeEventListener("keydown", this.hovercard.handleTriggerKeyDown);
    this.removeEventListener("click", this.handleClick);
    this.inlineObserver.disconnect();
    this.stopI18n?.();
    this.stopI18n = null;
    this.close();
    this.clearPreviews();
    super.disconnectedCallback();
  }

  protected override updated(): void {
    const context = this.syncPreviewContext();
    this.syncInlineStates();
    if (!this.activeAnchor) {
      return;
    }
    const anchor = this.activeAnchor;
    const target = this.activeTarget;
    if (!anchor || !target || !this.requestStarted) {
      return;
    }
    if (!this.isConnected || !this.contains(anchor) || anchor.href !== target.href) {
      this.close();
      return;
    }
    this.previewTask.render({
      pending: () => {
        const seed = this.seedPreview(target);
        if (this.hovercard.held) {
          if (seed) {
            this.show(anchor, seed, true);
          } else if (this.allowLoading && context?.succeeded) {
            this.show(anchor);
          }
        }
      },
      complete: (preview) => {
        if (preview.href === target.href && (this.hovercard.card || this.hovercard.held)) {
          this.show(anchor, preview);
        }
      },
      error: () => {
        const seed = this.seedPreview(target);
        if (seed && (this.hovercard.card || this.hovercard.held)) {
          this.show(anchor, seed, true);
        } else {
          this.close();
        }
      },
    });
  }

  private readonly handlePointerOver = (event: Event) => {
    const pointer = event as PointerEvent;
    if (pointer.pointerType === "touch") {
      return;
    }
    const anchor = githubLinkAnchorFromEvent(event);
    const target = anchor ? parseGitHubLinkTarget(anchor.href) : null;
    if (!anchor || !target) {
      return;
    }
    this.activateFromBootstrap(anchor, target, "pointer", GITHUB_HOVERCARD_OPEN_DELAY_MS);
  };

  private readonly handlePointerOut = (event: PointerEvent) => {
    const anchor = githubLinkAnchorFromEvent(event);
    if (!anchor || anchor !== this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.pointerInside = false;
    this.scheduleIntentClose();
  };

  private scheduleIntentClose(): void {
    if (this.previewTask.status === TaskStatus.PENDING && !this.hovercard.held) {
      this.close();
    } else {
      this.hovercard.scheduleClose();
    }
  }

  private readonly handleCardPointerLeave = () => {
    this.hovercard.pointerOverCard = false;
    // A pointer-opened card must release fully on mouse-out even if a click
    // inside the card (e.g. the title link) left it focused; otherwise it
    // would stay stuck open with nothing left driving the intent.
    if (this.activeTrigger === "pointer") {
      this.hovercard.cardFocusInside = false;
    }
    this.hovercard.scheduleClose();
  };

  private readonly handleFocusIn = (event: Event) => {
    if (this.hovercard.restoringFocus) {
      return;
    }
    const anchor = githubLinkAnchorFromEvent(event);
    const target = anchor ? parseGitHubLinkTarget(anchor.href) : null;
    if (!anchor || !target) {
      return;
    }
    this.activateFromBootstrap(anchor, target, "focus", 0);
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!this.activeAnchor) {
      return;
    }
    if (event.relatedTarget instanceof Node && this.activeAnchor.contains(event.relatedTarget)) {
      return;
    }
    this.hovercard.focusInside = false;
    this.scheduleIntentClose();
  };

  private readonly handleClick = () => {
    this.close();
  };

  activateFromBootstrap(
    anchor: HTMLAnchorElement,
    target: GitHubLinkTarget,
    trigger: "focus" | "pointer",
    delay: number,
  ): void {
    let owner: Element | null = anchor.parentElement;
    while (owner && !(owner instanceof GitHubLinkHovercardProvider)) {
      owner = owner.parentElement;
    }
    // Nested providers own their agent scope even when intent bubbles to the app provider.
    if (owner !== this) {
      return;
    }
    this.activate(anchor, target, delay);
    this.activeTrigger = trigger;
    if (trigger === "pointer") {
      this.hovercard.pointerInside = true;
    } else {
      this.hovercard.focusInside = true;
    }
  }

  private activate(anchor: HTMLAnchorElement, target: GitHubLinkTarget, delay: number): void {
    const context = this.syncPreviewContext();
    if (anchor === this.activeAnchor && this.activeTarget?.href === target.href) {
      return;
    }
    this.close();
    // Known session details remain useful while remote enrichment is unavailable.
    if (this.cachedPreview(target)?.failed && !this.seedPreview(target)) {
      return;
    }
    this.allowLoading = Boolean(context?.succeeded && !this.cachedPreview(target));
    this.activeAnchor = anchor;
    this.activeTarget = target;
    this.activeAnchorObserver.observe(this, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    // Unseeded links stay quiet until this identity has shown useful remote details.
    this.hovercard.scheduleOpen(
      delay,
      () => {
        if (this.syncPreviewContext() !== context) {
          return;
        }
        this.requestStarted = true;
        const seed = this.seedPreview(target);
        if (seed) {
          this.show(anchor, seed, true);
        }
        void this.previewTask.run([target]);
      },
      anchor,
    );
  }

  private show(anchor: HTMLAnchorElement, preview?: GitHubPreview, seeded = false): void {
    const existing = this.hovercard.card;
    const card =
      existing ??
      createPortaledHovercard(
        "openclaw-github-hovercard-" + ++nextHovercardId,
        "github-link-hovercard",
      );
    if (preview) {
      renderGitHubPreview(card, preview, seeded);
    } else {
      renderGitHubPreviewLoading(card);
    }
    if (existing) {
      this.hovercard.position();
    } else {
      // The provider's delegated listeners do not see the portaled card.
      card.addEventListener("pointerleave", this.handleCardPointerLeave);
      card.addEventListener("keydown", this.hovercard.handleCardKeyDown);
      this.hovercard.markTrigger(anchor);
      this.hovercard.mount(anchor, card, "vertical", true, () => render(nothing, card));
    }
    if (preview && !seeded && this.previewContext) {
      this.previewContext.succeeded = true;
    }
  }

  private cachedPreview(target: GitHubLinkTarget): CacheEntry | undefined {
    const cached = this.cache.get(gitHubPreviewKey(target));
    return cached && !cached.controller.signal.aborted && cached.expiresAt > Date.now()
      ? cached
      : undefined;
  }

  private loadPreview(
    target: GitHubLinkTarget,
    signal: AbortSignal,
  ): Promise<ControlUiGitHubPreview> {
    const key = gitHubPreviewKey(target);
    const now = Date.now();
    const cached = this.cachedPreview(target);
    this.cache.delete(key);
    // Dismissal invalidates only that request, even before its rejection settles.
    if (cached) {
      this.cache.set(key, cached);
      return subscribeToSharedRequest(cached, {}, signal);
    }

    const controller = new AbortController();
    const client = this.client;
    const context = this.previewContext;
    const agentId = this.agentId;
    const load = async (): Promise<ControlUiGitHubPreview> => {
      if (!this.client) {
        throw new Error("GitHub preview requires a connected Gateway");
      }
      const response = await this.client.request<ControlUiGitHubPreview>(
        "controlUi.githubPreview",
        {
          ...(this.agentId ? { agentId: this.agentId } : {}),
          kind: target.kind,
          number: target.number,
          owner: target.owner,
          repo: target.repo,
        },
        { signal: controller.signal },
      );
      return parsePreviewResponse(target, response);
    };

    const entry: CacheEntry = {
      expiresAt: now + SUCCESS_CACHE_MS,
      controller,
      subscribers: new Set(),
      promise: load()
        .then((preview) => {
          if (
            !controller.signal.aborted &&
            this.cache.get(key) === entry &&
            client === this.client &&
            agentId === this.agentId &&
            client &&
            previewContextFor(client, agentId) === context
          ) {
            entry.preview = preview;
            this.syncInlineStates();
          }
          return preview;
        })
        .catch((error: unknown) => {
          // Keep short-lived failures cached so repeatedly crossing a broken or
          // private link does not burn GitHub's anonymous rate limit.
          entry.failed = true;
          entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
          this.syncInlineStates();
          throw error;
        }),
    };
    this.cache.set(key, entry);
    this.syncInlineStates();
    while (this.cache.size > CACHE_LIMIT) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.cache.delete(oldestKey);
    }
    // Each visible transcript or popup owns its subscription, not the shared fetch.
    return subscribeToSharedRequest(entry, {}, signal);
  }

  private close(): void {
    this.requestStarted = false;
    this.allowLoading = false;
    this.hovercard.reset();
    this.activeAnchorObserver.disconnect();
    void this.previewTask.run([null]);
    this.activeAnchor = null;
    this.activeTarget = null;
    this.activeTrigger = null;
  }
}
