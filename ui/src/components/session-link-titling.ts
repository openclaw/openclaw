import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionsResolveParams,
  SessionsResolveResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ControlUiSessionPreview } from "../../../src/gateway/control-ui-contract.js";
import { pruneMapToMaxSize } from "../../../src/infra/map-size.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { pathForSession } from "../app-session-path-builder.ts";
import type { SessionPathTarget } from "../app-session-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { findLocalSessionReference } from "../pages/chat/route-loader-short-cache.ts";
import { stampSessionTitleLabel, type SessionTitleDisplay } from "./markdown-link-display.ts";
import {
  markdownSessionPublicOrigin,
  parseLocalMarkdownSessionUrl,
} from "./markdown-session-links.ts";

const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 100;

type SessionTitleTarget = {
  sessionKey: string;
  agentId: string;
  namespace: "chat" | "dashboard";
};

type SessionTitle = SessionTitleTarget & { title?: string };

type RegisteredTitle = {
  element: HTMLElement;
  label: HTMLElement;
  display?: SessionTitleDisplay;
};

/** A session URL the loaded roster cannot identify; the Gateway resolves it on demand. */
type SessionReference = {
  agentId: string;
  namespace: "chat" | "dashboard";
  cacheKey: string;
  params: SessionsResolveParams;
};

type CacheEntry<T = SessionTitle> = {
  expiresAt: number;
  promise: Promise<T>;
  value?: T;
};

export class SessionLinkTitler {
  private currentClient: GatewayBrowserClient | null = null;
  private currentContext: ApplicationContext | null = null;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly references = new Map<string, CacheEntry<SessionTitleTarget | null>>();
  private scope = {};
  private presentationScope: number | undefined;
  private readonly registered = new Map<HTMLElement, RegisteredTitle>();
  private refreshQueued = false;
  private readonly titledAnchors = new WeakMap<
    HTMLElement,
    { scope: object; key: string; title: string }
  >();

  get client() {
    return this.currentClient;
  }

  set client(client: GatewayBrowserClient | null) {
    if (client !== this.currentClient) {
      this.currentClient = client;
      this.retireTitles();
    }
  }

  get context() {
    return this.currentContext;
  }

  set context(context: ApplicationContext | null) {
    if (context !== this.currentContext) {
      this.currentContext = context;
      this.retireTitles();
    }
  }

  private retireTitles(): void {
    this.cache.clear();
    this.references.clear();
    this.scope = {};
  }

  private currentScope(): object {
    const scope = this.context ? gatewayPresentationScope(this.context.gateway).key : undefined;
    if (scope !== this.presentationScope) {
      this.presentationScope = scope;
      this.retireTitles();
    }
    return this.scope;
  }

  private canRead(method: string, client = this.client, scope?: object): boolean {
    return (
      client === this.client &&
      (scope === undefined || this.currentScope() === scope) &&
      canCallGatewayMethod(
        this.context && { ...this.context.gateway.snapshot, client },
        method,
        "operator.read",
        // Route resolution is an internal, deliberately unadvertised method.
        { requireAdvertisement: method !== "sessions.resolve" },
      )
    );
  }

  register(element: HTMLElement, label: HTMLElement, display?: SessionTitleDisplay): () => void {
    const entry = { element, label, display };
    this.registered.set(element, entry);
    if (!this.refreshQueued) {
      this.refreshQueued = true;
      queueMicrotask(() => {
        this.refreshQueued = false;
        this.refresh();
      });
    }
    return () => {
      if (this.registered.get(entry.element) === entry) {
        this.registered.delete(entry.element);
      }
    };
  }

  refresh(): void {
    // Share repeated references only within this synchronous roster projection.
    const targets = new Map<string, SessionTitleTarget | SessionReference | null>();
    // A code link can acquire an anchor, changing its registration key below.
    const registrations = [...this.registered.values()];
    for (const entry of registrations) {
      void this.decorate(entry.element, targets);
    }
  }

  disconnect(): void {
    // Native bridge remounts retain producer-owned DOM and registrations.
    this.client = null;
    this.context = null;
  }

  async decorate(
    element: HTMLElement,
    targets?: Map<string, SessionTitleTarget | SessionReference | null>,
  ): Promise<void> {
    const entry = this.registered.get(element);
    if (!entry) {
      return;
    }
    if (
      entry.display?.title &&
      (this.context?.gateway.snapshot.phase !== "connected" ||
        this.context.sessions.state.resultCached)
    ) {
      return;
    }
    const scope = this.currentScope();
    let target = this.targetForAnchor(element, targets);
    const anchor = stampSessionTitleLabel(element, entry.label);
    if (element !== anchor) {
      this.registered.delete(element);
      entry.element = anchor;
      this.registered.set(anchor, entry);
    }
    const previous = this.titledAnchors.get(anchor);
    if (previous && previous.scope !== scope) {
      if (entry.label.textContent === previous.title) {
        anchor.classList.remove("markdown-session-link--titled");
        entry.label.textContent = previous.key;
      }
      this.titledAnchors.delete(anchor);
    }
    if (target && !("sessionKey" in target)) {
      if (!this.canRead("sessions.resolve")) {
        return;
      }
      try {
        target = await this.resolveReference(target, scope);
      } catch {
        // Resolution is decoration; the URL remains navigable.
        return;
      }
      if (this.currentScope() !== scope || this.registered.get(anchor) !== entry) {
        return;
      }
    }
    if (!target) {
      return;
    }
    const cached = this.cachedOrSeededEntry(target);
    this.stampAnchor(entry, target, cached?.value);
    if (cached?.value) {
      return;
    }
    try {
      const title = await (cached?.promise ?? this.loadTitle(target));
      if (this.currentScope() === scope && this.registered.get(anchor) === entry) {
        this.stampAnchor(entry, target, title);
      }
    } catch {
      // A title is decoration; the session link remains usable with its raw key.
    }
  }

  private mainKey(): string {
    return resolveUiConfiguredMainKey({
      agentsList: this.context?.agents.state.agentsList,
      hello: this.context?.gateway.snapshot.hello,
    });
  }

  private targetForAnchor(
    anchor: HTMLElement,
    targets?: Map<string, SessionTitleTarget | SessionReference | null>,
  ): SessionTitleTarget | SessionReference | null {
    const rawKey = anchor.dataset.sessionKey?.trim();
    if (rawKey && !anchor.dataset.sessionHref) {
      const parsed = parseAgentSessionKey(rawKey);
      return parsed ? { sessionKey: rawKey, agentId: parsed.agentId, namespace: "chat" } : null;
    }
    const path = parseLocalMarkdownSessionUrl(
      anchor.dataset.sessionHref ?? anchor.getAttribute("href") ?? "",
      {
        basePath: this.context?.basePath,
        mainKey: this.mainKey(),
        publicOrigin: markdownSessionPublicOrigin(this.context),
      },
    );
    if (!path) {
      return null;
    }
    // Keep URL route intent (face, query, fragment) even when its identity is cached.
    const href = `${path.url.pathname}${path.url.search}${path.url.hash}`;
    if (anchor.getAttribute("href") !== href) {
      anchor.setAttribute("href", href);
    }
    if (!anchor.classList.contains("markdown-session-link")) {
      anchor.classList.add("markdown-session-link");
    }
    anchor.removeAttribute("target");
    anchor.removeAttribute("rel");
    let target = targets?.get(path.url.pathname);
    if (target === undefined) {
      const row = findLocalSessionReference(
        this.context?.sessions.state.result?.sessions ?? [],
        path.target,
        this.mainKey(),
      );
      target = row
        ? { sessionKey: row.key, agentId: path.target.agentId, namespace: path.target.namespace }
        : this.cachedReference(this.sessionReference(path.target));
      targets?.set(path.url.pathname, target);
    }
    if (!target || !("sessionKey" in target)) {
      anchor.removeAttribute("data-session-key");
    }
    return target;
  }

  // Mirrors the chat route loader's lookups so a link resolves to the session it opens.
  private sessionReference(target: SessionPathTarget): SessionReference {
    const params: SessionsResolveParams =
      target.kind === "short"
        ? {
            shortId: target.shortId,
            ...(target.slugHint ? { slugHint: target.slugHint } : {}),
            agentId: target.agentId,
            allowMissing: true,
          }
        : {
            reference: {
              key:
                target.kind === "main"
                  ? buildAgentMainSessionKey({ agentId: target.agentId, mainKey: this.mainKey() })
                  : target.sessionKey,
              ...(target.kind === "literal" && target.slugCandidate
                ? { slug: target.slugCandidate }
                : {}),
            },
            agentId: target.agentId,
            includeGlobal: true,
            includeUnknown: true,
            allowMissing: true,
          };
    return {
      agentId: target.agentId,
      namespace: target.namespace,
      cacheKey: JSON.stringify(params),
      params,
    };
  }

  private cachedReference(
    reference: SessionReference,
  ): SessionTitleTarget | SessionReference | null {
    const cached = this.references.get(reference.cacheKey);
    return cached && cached.expiresAt > Date.now() && cached.value !== undefined
      ? cached.value
      : reference;
  }

  private resolveReference(
    reference: SessionReference,
    scope: object,
  ): Promise<SessionTitleTarget | null> {
    const now = Date.now();
    const cached = this.references.get(reference.cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.promise;
    }
    const client = this.client;
    return this.load(this.references, reference.cacheKey, async () => {
      if (!client || !this.canRead("sessions.resolve", client, scope)) {
        throw new Error("Session link resolution requires a connected Gateway");
      }
      const result = await client.request<SessionsResolveResult>(
        "sessions.resolve",
        reference.params,
      );
      if (!result.ok) {
        // Missing and ambiguous references stay plain links.
        return null;
      }
      const target = {
        sessionKey: result.key,
        agentId: result.agentId,
        namespace: reference.namespace,
      };
      const title = readNonBlankString(result.displayName);
      if (title && this.scope === scope && !this.cache.has(target.sessionKey)) {
        const value = { ...target, title };
        this.remember(this.cache, target.sessionKey, {
          expiresAt: Date.now() + SUCCESS_CACHE_MS,
          promise: Promise.resolve(value),
          value,
        });
      }
      return target;
    });
  }

  private remember<T>(cache: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>): void {
    cache.delete(key);
    cache.set(key, entry);
    pruneMapToMaxSize(cache, CACHE_LIMIT);
  }

  private load<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    request: () => Promise<T>,
  ): Promise<T> {
    const entry: CacheEntry<T> = {
      expiresAt: Date.now() + SUCCESS_CACHE_MS,
      promise: Promise.resolve().then(request),
    };
    entry.promise = entry.promise.then(
      (value) => {
        entry.value = value;
        if (value === null) {
          entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
        }
        return value;
      },
      (error: unknown) => {
        entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
        throw error;
      },
    );
    this.remember(cache, key, entry);
    return entry.promise;
  }

  private cachedOrSeededEntry(target: SessionTitleTarget): CacheEntry | undefined {
    const now = Date.now();
    const cached = this.cache.get(target.sessionKey);
    const row = this.context?.sessions.state.result?.sessions.find((candidate) =>
      areUiSessionKeysEquivalent(candidate.key, target.sessionKey),
    );
    if (!row) {
      if (cached && cached.expiresAt > now) {
        this.remember(this.cache, target.sessionKey, cached);
        return cached;
      }
      this.cache.delete(target.sessionKey);
      return undefined;
    }
    const value: SessionTitle = {
      ...target,
      sessionKey: row.key,
      agentId: row.agentId ?? parseAgentSessionKey(row.key)?.agentId ?? target.agentId,
      title: row.displayName ?? row.derivedTitle,
    };
    if (
      cached?.value &&
      cached.expiresAt > now &&
      cached.value.sessionKey === value.sessionKey &&
      cached.value.agentId === value.agentId &&
      cached.value.title === value.title
    ) {
      this.remember(this.cache, target.sessionKey, cached);
      return cached;
    }
    const entry = { expiresAt: now + SUCCESS_CACHE_MS, promise: Promise.resolve(value), value };
    this.remember(this.cache, target.sessionKey, entry);
    return entry;
  }

  private loadTitle(target: SessionTitleTarget): Promise<SessionTitle | undefined> {
    const client = this.client;
    if (!client || !this.canRead("controlUi.sessionPreview", client)) {
      return Promise.resolve(undefined);
    }
    const scope = this.currentScope();
    return this.load(this.cache, target.sessionKey, async () => {
      if (!this.canRead("controlUi.sessionPreview", client, scope)) {
        throw new Error("Session title requires a connected Gateway");
      }
      const value = await client.request<ControlUiSessionPreview>("controlUi.sessionPreview", {
        sessionKey: target.sessionKey,
      });
      if (value.status !== "ok") {
        throw new Error("Session title unavailable");
      }
      return {
        sessionKey: value.sessionKey,
        agentId: value.agentId,
        namespace: target.namespace,
        title: readNonBlankString(value.title) ?? readNonBlankString(value.derivedTitle),
      };
    });
  }

  private stampAnchor(
    entry: RegisteredTitle,
    target: SessionTitleTarget,
    titleRecord?: SessionTitle,
  ): void {
    const { element: anchor, label } = entry;
    const title = titleRecord?.title;
    const href = pathForSession(
      target.namespace,
      target.agentId,
      target.sessionKey,
      this.context?.basePath,
      { displayName: title, exactKey: true, mainKey: this.mainKey() },
    );
    if (anchor.dataset.sessionKey !== target.sessionKey) {
      anchor.dataset.sessionKey = target.sessionKey;
    }
    if (!anchor.hasAttribute("data-session-title-only")) {
      if (!anchor.classList.contains("markdown-session-link")) {
        anchor.classList.add("markdown-session-link");
      }
      if (!anchor.dataset.sessionHref && href && anchor.getAttribute("href") !== href) {
        anchor.setAttribute("href", href);
      }
    }
    const previous = this.titledAnchors.get(anchor);
    const ownedTitle = previous?.title ?? entry.display?.title;
    if (
      anchor.classList.contains("markdown-session-link--titled") &&
      (ownedTitle === undefined || label.textContent !== ownedTitle)
    ) {
      return;
    }
    if (!title) {
      if (
        titleRecord &&
        ownedTitle !== undefined &&
        anchor.classList.contains("markdown-session-link--titled")
      ) {
        anchor.classList.remove("markdown-session-link--titled");
        label.textContent = target.sessionKey;
        this.titledAnchors.delete(anchor);
        entry.display?.onTitle(undefined);
      }
      return;
    }
    this.titledAnchors.set(anchor, { scope: this.scope, key: target.sessionKey, title });
    // The producer retains this label across later rendering updates.
    stampSessionTitleLabel(anchor, label, title);
    entry.display?.onTitle(title);
  }
}
