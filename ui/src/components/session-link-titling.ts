import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import {
  areUiSessionKeysEquivalent,
  buildAgentMainSessionKey,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { findLocalSessionReference } from "../pages/chat/route-loader-short-cache.ts";
import {
  markdownSessionPublicOrigin,
  parseLocalMarkdownSessionUrl,
} from "./markdown-session-links.ts";
import { SESSION_TITLE_TARGET_SELECTOR } from "./session-progress-hovercard-target.ts";

const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const CACHE_LIMIT = 100;

type SessionTitleTarget = {
  sessionKey: string;
  agentId: string;
  namespace: "chat" | "dashboard";
};

type SessionTitle = SessionTitleTarget & { title?: string };

/** A session URL the loaded roster cannot identify; the Gateway resolves it on demand. */
type SessionReference = {
  agentId: string;
  namespace: "chat" | "dashboard";
  cacheKey: string;
  params: SessionsResolveParams;
};

type CacheEntry = {
  expiresAt: number;
  promise: Promise<SessionTitle>;
  value?: SessionTitle;
};

type ReferenceEntry = {
  expiresAt: number;
  promise: Promise<SessionTitleTarget | null>;
  value?: SessionTitleTarget | null;
};

function titleFromPreview(value: unknown): SessionTitle {
  if (!isRecord(value) || value.status !== "ok") {
    throw new Error("Session title unavailable");
  }
  const sessionKey = readNonBlankString(value.sessionKey);
  const agentId = readNonBlankString(value.agentId);
  if (!sessionKey || !agentId) {
    throw new Error("Session title response was incomplete");
  }
  return {
    sessionKey,
    agentId,
    namespace: "chat",
    title: readNonBlankString(value.title) ?? readNonBlankString(value.derivedTitle),
  };
}

export class SessionLinkTitler {
  private currentClient: GatewayBrowserClient | null = null;
  private currentContext: ApplicationContext | null = null;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly references = new Map<string, ReferenceEntry>();
  private scope = {};
  private presentationScope: number | undefined;
  private readonly titledAnchors = new WeakMap<
    HTMLElement,
    { scope: object; key: string; title: string }
  >();
  private readonly observer = new MutationObserver((records) => {
    for (const node of records.flatMap((record) => [...record.addedNodes])) {
      if (node instanceof HTMLElement) {
        this.refresh(node);
      }
    }
  });

  constructor(private readonly host: HTMLElement) {}

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

  connect(): void {
    this.observer.observe(this.host, { childList: true, subtree: true });
    this.refresh();
  }

  refresh(root = this.host): void {
    // Share repeated references only within this synchronous roster projection.
    const targets = new Map<string, SessionTitleTarget | SessionReference | null>();
    if (root.matches(SESSION_TITLE_TARGET_SELECTOR)) {
      void this.decorate(root, true, targets);
    }
    for (const anchor of root.querySelectorAll<HTMLElement>(SESSION_TITLE_TARGET_SELECTOR)) {
      void this.decorate(anchor, true, targets);
    }
  }

  disconnect(): void {
    this.observer.disconnect();
  }

  async decorate(
    element: HTMLElement,
    load = false,
    targets?: Map<string, SessionTitleTarget | SessionReference | null>,
  ): Promise<void> {
    const scope = this.currentScope();
    let target = this.targetForAnchor(element, targets);
    const anchor =
      element instanceof HTMLAnchorElement || element.hasAttribute("data-session-title-only")
        ? element
        : document.createElement("a");
    if (element !== anchor && element.classList.contains("markdown-session-link")) {
      anchor.dataset.sessionHref = element.dataset.sessionHref;
      anchor.setAttribute("href", element.getAttribute("href") ?? "");
      anchor.className = "markdown-session-link";
      element.classList.remove("markdown-session-link");
      element.removeAttribute("href");
      element.removeAttribute("data-session-href");
      element.replaceWith(anchor);
      anchor.append(element);
    }
    const previous = this.titledAnchors.get(anchor);
    if (previous && previous.scope !== scope) {
      const label = anchor.querySelector<HTMLSpanElement>(":scope > .session-label");
      if (label?.textContent === previous.title) {
        anchor.classList.remove("markdown-session-link--titled");
        label.textContent = previous.key;
      }
      this.titledAnchors.delete(anchor);
    }
    if (target && !("sessionKey" in target)) {
      if (!load) {
        return;
      }
      try {
        target = await this.resolveReference(target, scope);
      } catch {
        // Resolution is decoration; the URL remains navigable.
        return;
      }
      if (this.currentScope() !== scope) {
        return;
      }
    }
    if (!target) {
      return;
    }
    const cached = this.cachedOrSeededEntry(target);
    this.stampAnchor(anchor, target, cached?.value);
    if (!load || cached?.value) {
      return;
    }
    try {
      const title = await this.loadTitle(target);
      if (this.currentScope() === scope) {
        this.stampAnchor(anchor, target, title);
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
    const entry: ReferenceEntry = {
      expiresAt: now + SUCCESS_CACHE_MS,
      promise: Promise.resolve().then(async () => {
        if (!client) {
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
          this.setCacheEntry(target.sessionKey, {
            expiresAt: Date.now() + SUCCESS_CACHE_MS,
            promise: Promise.resolve(value),
            value,
          });
        }
        return target;
      }),
    };
    entry.promise = entry.promise.then(
      (value) => {
        entry.value = value;
        if (!value) {
          entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
        }
        return value;
      },
      (error: unknown) => {
        entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
        throw error;
      },
    );
    this.references.delete(reference.cacheKey);
    this.references.set(reference.cacheKey, entry);
    pruneMapToMaxSize(this.references, CACHE_LIMIT);
    return entry.promise;
  }

  private setCacheEntry(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    pruneMapToMaxSize(this.cache, CACHE_LIMIT);
  }

  private cachedOrSeededEntry(target: SessionTitleTarget): CacheEntry | undefined {
    const now = Date.now();
    const cached = this.cache.get(target.sessionKey);
    if (cached && cached.expiresAt > now) {
      this.setCacheEntry(target.sessionKey, cached);
      return cached;
    }
    this.cache.delete(target.sessionKey);
    const row = this.context?.sessions.state.result?.sessions.find((candidate) =>
      areUiSessionKeysEquivalent(candidate.key, target.sessionKey),
    );
    if (!row) {
      return undefined;
    }
    const value: SessionTitle = {
      ...target,
      sessionKey: row.key,
      agentId: row.agentId ?? parseAgentSessionKey(row.key)?.agentId ?? target.agentId,
      title: row.displayName ?? row.derivedTitle,
    };
    const entry = { expiresAt: now + SUCCESS_CACHE_MS, promise: Promise.resolve(value), value };
    this.setCacheEntry(target.sessionKey, entry);
    return entry;
  }

  private loadTitle(target: SessionTitleTarget): Promise<SessionTitle> {
    const cached = this.cachedOrSeededEntry(target);
    if (cached) {
      return cached.promise;
    }
    const client = this.client;
    const load = async () => {
      if (!client) {
        throw new Error("Session title requires a connected Gateway");
      }
      const title = titleFromPreview(
        await client.request<ControlUiSessionPreview>("controlUi.sessionPreview", {
          sessionKey: target.sessionKey,
        }),
      );
      return { ...title, namespace: target.namespace };
    };
    const entry: CacheEntry = {
      expiresAt: Date.now() + SUCCESS_CACHE_MS,
      promise: Promise.resolve().then(load),
    };
    entry.promise = entry.promise.then(
      (value) => {
        entry.value = value;
        return value;
      },
      (error: unknown) => {
        entry.expiresAt = Date.now() + FAILURE_CACHE_MS;
        throw error;
      },
    );
    this.setCacheEntry(target.sessionKey, entry);
    return entry.promise;
  }

  private stampAnchor(
    anchor: HTMLElement,
    target: SessionTitleTarget,
    titleRecord?: SessionTitle,
  ): void {
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
    if (!title || anchor.classList.contains("markdown-session-link--titled")) {
      return;
    }
    anchor.classList.add("markdown-session-link--titled");
    this.titledAnchors.set(anchor, { scope: this.scope, key: target.sessionKey, title });
    // Keep a producer's label node so Lit can still update its text binding.
    const label =
      anchor.querySelector<HTMLSpanElement>(":scope > .session-label") ??
      document.createElement("span");
    label.className = "session-label";
    label.textContent = title;
    anchor.replaceChildren(label);
  }
}
