import { expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import {
  markdownSessionLinkFromEvent,
  markdownSessionLinkFromKeyboardEvent,
  navigateMarkdownSession,
  type SessionLinkTarget,
} from "./markdown-session-links.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { SessionLinkTitler } from "./session-link-titling.ts";

function makeContext(
  rows?: { key: string; agentId: string; displayName: string }[],
  navigate = vi.fn(),
) {
  return {
    basePath: "",
    sessions: { state: rows ? { result: { sessions: rows } } : {} },
    agents: { state: {} },
    agentSelection: { state: {} },
    gateway: { snapshot: {} },
    navigate,
  } as unknown as ApplicationContext;
}

it.each(["", "?view=full#latest"])(
  "refreshes a cleaned session title with suffix %j",
  async (suffix) => {
    const sessionKey = "agent:main:dashboard:d0effac9-3211-4641-b993-10f619f124e6";
    const pathname = "/chat/main/d0effac9";
    const href = `${location.origin}${pathname}${suffix}`;
    const host = document.createElement("div");
    host.innerHTML = toSanitizedMarkdownHtml(`${href}重新解读`, { sessionLinks: true });
    const anchor = host.querySelector<HTMLAnchorElement>("a")!;
    const titler = new SessionLinkTitler();
    titler.context = makeContext([{ key: sessionKey, agentId: "main", displayName: "Research" }]);

    titler.register(anchor, document.createElement("span"));
    await titler.decorate(anchor);
    titler.refresh();

    expect(anchor).toMatchObject({
      textContent: "Research",
      dataset: { sessionKey, sessionHref: href },
    });
    expect(anchor.getAttribute("href")).toBe(`${pathname}${suffix}`);
    expect(anchor.nextSibling?.textContent).toBe("重新解读");
  },
);

it("navigates through the canonical chat session route", () => {
  const navigate = vi.fn();
  navigateMarkdownSession(makeContext(undefined, navigate), {
    sessionKey: "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6",
    agentId: "roboclaw",
  });
  expect(navigate).toHaveBeenCalledWith("chat", {
    pathname: "/chat/roboclaw/dashboard/2139bddb-3211-4641-b993-10f619f124e6",
    search: "?__openclawSessionFacePreference=1",
  });
});
it.each([
  ["click", "a"],
  [" ", "a"],
  ["Enter", "code"],
])("routes public-origin %s on %s before hovercard init", (action, tag) => {
  const runtimeConfig = { gateway: { publicOrigin: "https://CHAT.example:443/" } };
  const provider = Object.assign(
    document.createElement("openclaw-session-progress-hovercard-provider"),
    {
      context: {
        basePath: "/control",
        runtimeConfig: { state: { configSnapshot: { runtimeConfig } } },
      },
    },
  );
  const anchor = document.createElement(tag);
  const href = "https://chat.example/control/chat/roboclaw/d0effac9?view=full#latest";
  if (tag === "a") {
    anchor.setAttribute("href", href);
  } else {
    anchor.dataset.sessionHref = href;
  }
  provider.append(anchor);
  let resolved: SessionLinkTarget | null = null;
  anchor.addEventListener(action === "click" ? "click" : "keydown", (event) => {
    resolved =
      event instanceof KeyboardEvent
        ? markdownSessionLinkFromKeyboardEvent(event)
        : markdownSessionLinkFromEvent(event);
    if (event instanceof MouseEvent) {
      event.preventDefault();
    }
  });
  const event =
    action === "click"
      ? new MouseEvent("click", { bubbles: true, cancelable: true })
      : new KeyboardEvent("keydown", { key: action, bubbles: true, cancelable: true });
  anchor.dispatchEvent(event);
  expect(resolved).toEqual({
    namespace: "chat",
    pathname: "/control/chat/roboclaw/d0effac9",
    search: "?view=full",
    hash: "#latest",
  });
  expect(anchor.dataset.sessionKey).toBeUndefined();
  expect(anchor.getAttribute("href") ?? anchor.dataset.sessionHref).toBe(href);
  if (action !== "click") {
    expect(event.defaultPrevented).toBe(true);
  }
});
