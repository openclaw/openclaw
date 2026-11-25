import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { ControlUiSessionNamespace } from "@openclaw/session-url-contract";
import type { MarkdownIt, Token } from "markdown-it";
import { resolveGatewayPublicOrigin } from "../../../src/config/gateway-public-origin.js";
import { templateCatalogPackageNameFromPath } from "../app-route-paths.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import { resolveControlUiPaths } from "../app/browser.ts";
import type { ApplicationContext } from "../app/context.ts";
import { releasedSessionQuery } from "../app/released-session-query.ts";
import { currentDisplayRuntimeConfig } from "../lib/config/config-state-model.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { parseAgentSessionKey, resolveUiConfiguredMainKey } from "../lib/sessions/session-key.ts";
import { hasMarkdownLinkBoundaries } from "./markdown-link-boundary.ts";
import {
  markdownInlineChildren,
  replaceMarkdownTextMatches,
} from "./markdown-text-replacements.ts";

const SESSION_LINK_SCAN_RE = /agent:[^\s<>"'`]*[^\s<>"'`.,;:!?)}\]]/g;

type SessionKeyTarget = {
  sessionKey: string;
  agentId: string;
};

type SessionPathTarget = {
  namespace: ControlUiSessionNamespace;
  pathname: string;
  search?: string;
  hash?: string;
};

export type SessionLinkTarget = SessionKeyTarget | SessionPathTarget;

function markdownLinkUrl(raw: string) {
  return globalThis.location ? URL.parse(raw, globalThis.location.href) : null;
}

function parseSessionLinkKey(raw: string): SessionKeyTarget | null {
  const sessionKey = raw.trim();
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed || `agent:${parsed.agentId}:${parsed.rest}` !== sessionKey.toLowerCase()) {
    return null;
  }
  return { sessionKey, agentId: parsed.agentId };
}

function parseMarkdownSessionUrl(
  raw: string,
  basePath?: string,
  mainKey?: string,
  url = markdownLinkUrl(raw),
) {
  if (
    !url ||
    !/^(?:https?:\/\/|\/)/i.test(raw.trim()) ||
    (url.protocol !== "http:" && url.protocol !== "https:")
  ) {
    return null;
  }
  const mount = basePath ?? resolveControlUiPaths(globalThis.location.pathname)[0];
  const released = releasedSessionQuery(url, mount);
  if (released) {
    // Unqualified keys belong to startup, which can resolve their agent.
    const pathname = released.path("", mainKey);
    if (!pathname) {
      return null;
    }
    url.pathname = pathname;
    url.search = released.search;
  }
  const target = sessionRefFromPath(url.pathname, mount, mainKey);
  return target && { url, target };
}

export function parseLocalMarkdownSessionUrl(
  raw: string,
  options: { basePath?: string; mainKey?: string; publicOrigin?: string } = {},
) {
  const path = parseMarkdownSessionUrl(raw, options.basePath, options.mainKey);
  return path &&
    (path.url.origin === globalThis.location.origin || path.url.origin === options.publicOrigin)
    ? path
    : null;
}

export function installMarkdownSessionLinks(markdownParser: MarkdownIt): void {
  // Capture cleaned hrefs before file decoration can claim session-shaped paths.
  markdownParser.core.ruler.before("file-links", "session-links", (state) => {
    if (state.env?.sessionLinks !== true) {
      return;
    }
    const decorate = (token: Token, raw: string, url?: URL | null): boolean => {
      const key = parseSessionLinkKey(raw);
      const path = key ? null : parseMarkdownSessionUrl(raw, undefined, undefined, url);
      if (!key && !path) {
        return false;
      }
      if (path) {
        // The context-aware titler also recognizes the Gateway's configured public origin.
        token.attrSet("data-session-href", raw);
        if (path.url.origin !== globalThis.location.origin) {
          return false;
        }
        token.attrSet("href", raw);
      } else if (key) {
        token.attrSet("data-session-key", key.sessionKey);
      }
      token.attrJoin("class", "markdown-session-link");
      token.attrSet("role", "link");
      token.attrSet("tabindex", "0");
      return true;
    };
    for (const children of markdownInlineChildren(state.tokens)) {
      let linkDepth = 0;
      for (let index = 0; index < children.length; index++) {
        const token = children[index];
        if (!token) {
          continue;
        }
        if (token.type === "link_open") {
          const href = String(token.attrGet("href") ?? "");
          const url = markdownLinkUrl(href);
          const template =
            url &&
            url.origin === globalThis.location.origin &&
            !url.search &&
            !url.hash &&
            templateCatalogPackageNameFromPath(
              url.pathname,
              resolveControlUiPaths(globalThis.location.pathname)[0],
            );
          if (template) {
            token.attrJoin("class", "markdown-template-link");
            token.attrSet("data-template-package", template);
            token.attrSet("aria-haspopup", "dialog");
          } else {
            decorate(token, href, url);
          }
          linkDepth++;
        } else if (token.type === "link_close") {
          linkDepth--;
        } else if (linkDepth === 0 && token.type === "code_inline") {
          const open = new state.Token("link_open", "a", 1);
          if (decorate(open, token.content)) {
            children.splice(index, 1, open, token, new state.Token("link_close", "a", -1));
            index += 2;
          } else if (open.attrGet("data-session-href")) {
            token.attrSet("data-session-href", token.content);
          }
        } else if (linkDepth === 0 && token.type === "text") {
          index = replaceMarkdownTextMatches(
            state,
            children,
            index,
            SESSION_LINK_SCAN_RE,
            (match) => {
              const end = match.index + match[0].length;
              const open = new state.Token("link_open", "a", 1);
              if (
                !hasMarkdownLinkBoundaries(token.content, match.index, end) ||
                !decorate(open, match[0])
              ) {
                return null;
              }
              const label = new state.Token("text", "", 0);
              label.content = match[0];
              return [open, label, new state.Token("link_close", "a", -1)];
            },
          );
        }
      }
    }
  });
}

export function markdownSessionPublicOrigin(
  context?: ApplicationContext | null,
): string | undefined {
  const config = context?.runtimeConfig
    ? currentDisplayRuntimeConfig(context.runtimeConfig.state)
    : null;
  return resolveGatewayPublicOrigin({
    gateway: { publicOrigin: readNonBlankString(asOptionalRecord(config?.gateway)?.publicOrigin) },
  });
}

export function markdownSessionLinkFromEvent(
  event: Event,
  basePath?: string,
): SessionLinkTarget | null {
  const anchor =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>("a, [data-session-href]")
      : null;
  if (!anchor) {
    return null;
  }
  const sessionKey = anchor.dataset.sessionKey;
  if (sessionKey && !anchor.dataset.sessionHref) {
    return parseSessionLinkKey(sessionKey);
  }
  // Routing must not wait for the lazy hovercard provider to upgrade.
  const context = anchor.closest<HTMLElement & { context?: ApplicationContext | null }>(
    "openclaw-session-progress-hovercard-provider",
  )?.context;
  const path = parseLocalMarkdownSessionUrl(
    anchor.getAttribute("href") ?? anchor.dataset.sessionHref ?? "",
    {
      basePath: basePath ?? context?.basePath,
      mainKey: resolveUiConfiguredMainKey({
        agentsList: context?.agents.state.agentsList,
        hello: context?.gateway.snapshot.hello,
      }),
      publicOrigin: markdownSessionPublicOrigin(context),
    },
  );
  if (!path) {
    return null;
  }
  const { url, target: parsed } = path;
  return {
    namespace: parsed.namespace,
    pathname: url.pathname,
    ...(url.search ? { search: url.search } : {}),
    ...(url.hash ? { hash: url.hash } : {}),
  };
}

export function markdownSessionLinkFromKeyboardEvent(
  event: KeyboardEvent,
  basePath?: string,
): SessionLinkTarget | null {
  if (event.key !== "Enter" && event.key !== " ") {
    return null;
  }
  const target = markdownSessionLinkFromEvent(event, basePath);
  if (target) {
    event.preventDefault();
  }
  return target;
}

export function navigateMarkdownSession(
  context: ApplicationContext,
  target: SessionLinkTarget,
): void {
  if ("pathname" in target) {
    const { namespace, ...options } = target;
    context.navigate(namespace, options);
    return;
  }
  const navigation = sessionNavigationTarget({
    context,
    face: "chat",
    sessionKey: target.sessionKey,
    agentId: target.agentId,
    exactKey: true,
    preferenceDerivedFace: true,
  });
  context.navigate("chat", navigation.options);
}
