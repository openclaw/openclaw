import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { renderPublicSessionDocument } from "./control-ui-public-session-render.js";

const readers: JSDOM[] = [];
afterEach(() => readers.splice(0).forEach((dom) => dom.window.close()));

type ProbeResponse = { status: number; type?: string };
type ReaderOptions = {
  url?: string;
  basePath?: string;
  clientAuth?: boolean;
  token?: string;
  device?: string;
  storedScope?: string;
  probe?: Promise<ProbeResponse>;
  unavailable?: boolean;
  blockedStorage?: boolean;
  messages?: unknown[];
};
function openReader(options: ReaderOptions = {}) {
  const basePath = options.basePath ?? "/control";
  const dom = new JSDOM(
    renderPublicSessionDocument({
      title: "Conversation unavailable",
      messages: options.messages ?? [],
      widgetUrls: new Map([
        ["cv_size", "/control/share/session/media?widget=size"],
        ["cv_other", "/control/share/session/media?widget=other"],
      ]),
      truncated: false,
      unavailable: options.unavailable !== false,
      latestUrl: "/control/chat/main/private",
      cardUrl: "https://gateway.test/control/share/card.png",
      assetBasePath: basePath,
      entryUrl: `${basePath}/__openclaw__/session-entry?path=${encodeURIComponent(`${basePath}/chat/main/private`)}`,
      ...(options.clientAuth !== false ? { clientAuthBasePath: basePath } : {}),
    }),
    { url: options.url ?? "https://gateway.test/control/chat/main/private" },
  );
  const { document, localStorage, sessionStorage, location } = dom.window;
  // The script runs below; match a browser with JavaScript enabled.
  document.querySelectorAll("noscript").forEach((node) => node.remove());
  const scope =
    options.storedScope ??
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${basePath}`;
  if (options.token !== undefined) {
    sessionStorage.setItem(`openclaw.control.token.v1:${scope}`, options.token);
  }
  if (options.device !== undefined) {
    localStorage.setItem(`openclaw.device.auth.v1:${scope}`, options.device);
  }
  const replace = vi.fn();
  const fetch = vi.fn().mockReturnValue(options.probe ?? Promise.resolve({ status: 401 }));
  const storage = options.blockedStorage
    ? {
        getItem() {
          throw new Error("Storage blocked");
        },
      }
    : undefined;
  runInNewContext(document.querySelector("script")!.textContent!, {
    document,
    window: dom.window,
    location: { protocol: location.protocol, host: location.host, hash: location.hash, replace },
    localStorage: storage ?? localStorage,
    sessionStorage: storage ?? sessionStorage,
    fetch,
    URLSearchParams,
    AbortSignal,
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
  });
  readers.push(dom);
  const loginVisibility = () =>
    dom.window.getComputedStyle(document.getElementById("session-login")!).visibility;
  return { replace, fetch, document, loginVisibility, window: dom.window };
}

const device = JSON.stringify({
  tokens: { operator: { token: "synthetic-device-token" } },
});
const entry =
  "https://gateway.test/control/__openclaw__/session-entry?path=%2Fcontrol%2Fchat%2Fmain%2Fprivate";

function expectUnavailable(f: ReturnType<typeof openReader>) {
  expect(f.document.querySelector("main")!.hasAttribute("data-entry-pending")).toBe(false);
  expect(f.document.title).toBe("Conversation unavailable · OpenClaw");
  expect(f.loginVisibility()).toBe("visible");
  expect(f.replace).not.toHaveBeenCalled();
}

function expectPending(f: ReturnType<typeof openReader>) {
  expect(f.document.querySelector("main")!.hasAttribute("data-entry-pending")).toBe(true);
  expect(f.document.title).not.toContain("unavailable");
  expect(f.loginVisibility()).toBe("hidden");
  expect(f.replace).not.toHaveBeenCalled();
}

const storedDevice = (storedScope: string) => ({ device, storedScope });

describe("public reader operator handoff", () => {
  it("resizes only the sending widget frame and ignores unrelated or invalid messages", () => {
    const f = openReader({
      unavailable: false,
      messages: [
        { role: "assistant", content: '[embed ref="cv_size" /] [embed ref="cv_other" /]' },
      ],
    });
    const [frame, other] = Array.from(f.document.querySelectorAll("iframe"));
    const send = (data: unknown, source = frame!.contentWindow) =>
      f.window.dispatchEvent(new f.window.MessageEvent("message", { data, source }));
    send({ type: "openclaw:widget-size", height: 730 });
    expect(frame!.style.height).toBe("730px");
    expect(other!.style.height).toBe("420px");
    send({ type: "openclaw:widget-size", height: 1 });
    expect(frame!.style.height).toBe("48px");
    send({ type: "openclaw:widget-size", height: 9000 });
    expect(frame!.style.height).toBe("8000px");
    for (const data of [
      null,
      { type: "openclaw:widget-prompt", height: 500 },
      { type: "openclaw:widget-size", height: "500" },
      { type: "openclaw:widget-size", height: Infinity },
    ]) {
      send(data);
    }
    send({ type: "openclaw:widget-size", height: 500 }, other!.contentWindow);
    expect(other!.style.height).toBe("500px");
    send({ type: "openclaw:widget-size", height: 600 }, null);
    expect(frame!.style.height).toBe("8000px");
    expect(other!.style.height).toBe("500px");
  });
  it.each(["network", "server"])("does not present %s failures as denied access", async (kind) => {
    const probe = createDeferred<{ status: number }>();
    const f = openReader({ probe: probe.promise });
    if (kind === "server") {
      probe.resolve({ status: 503 });
    } else {
      probe.reject(new Error(kind));
    }
    await probe.promise.catch(() => {});
    await Promise.resolve();
    expect(f.document.querySelector("main")!.hasAttribute("data-entry-pending")).toBe(true);
    expect(f.document.querySelector(".entry-status")?.textContent).toContain(
      "Could not check access",
    );
    expect(f.document.querySelector(".entry-status")?.textContent).toContain("reload or log in");
    expect(f.document.title).not.toContain("unavailable");
    expect(f.loginVisibility()).toBe("visible");
    expect(f.replace).not.toHaveBeenCalled();
  });

  it("leaves a public transcript readable while the optional handoff is pending", () => {
    const probe = createDeferred<{ status: number }>();
    const f = openReader({ probe: probe.promise, unavailable: false });
    expect(f.document.querySelector("main")!.hasAttribute("data-entry-pending")).toBe(false);
    expect(f.document.querySelector(".transcript")).not.toBeNull();
    expect(f.document.querySelector(".entry-status")).toBeNull();
  });

  it.for<[string, ReaderOptions, string?, ProbeResponse?]>([
    ["cached token", { token: "synthetic-token" }, entry],
    ["signed-out probe", {}],
    ["proxy login redirect", {}, undefined, { status: 0, type: "opaqueredirect" }],
    ["paired device", { device }, entry],
    ["query scope", storedDevice("wss://gateway.test/control?account=work"), entry],
    [
      "token fragment",
      { url: "https://gateway.test/control/chat/main/private#token=synthetic-token" },
      `${entry}#token=synthetic-token`,
    ],
    [
      "loopback fragment",
      { url: "http://127.0.0.1:12345/control/chat/main/private#message-42", device },
      entry.replace("https://gateway.test", "http://127.0.0.1:12345") + "#message-42",
    ],
    [
      "root mount",
      { basePath: "", url: "http://127.0.0.1:12345/chat/main/private", device },
      "http://127.0.0.1:12345/__openclaw__/session-entry?path=%2Fchat%2Fmain%2Fprivate",
    ],
    ["authenticated proxy", { clientAuth: false }, entry, { status: 204 }],
    ["empty token", { token: " " }],
    ["another gateway", { ...storedDevice("wss://other.test/control"), token: "synthetic-token" }],
    [
      "another mount with query scope",
      storedDevice("wss://gateway.test/control-other?account=work"),
    ],
    ["another scheme", { ...storedDevice("ws://gateway.test/control"), token: "synthetic-token" }],
    ["malformed storage", { device: "not-json" }],
    ["cleared device token", { device: '{"tokens":{}}' }],
    ["blocked storage", { blockedStorage: true }],
    [
      "denied HTTP identity despite cached credentials",
      { token: "synthetic-token", device },
      undefined,
      { status: 403 },
    ],
  ])("resolves %s only after the access probe", async ([_name, options, redirect, response]) => {
    const probe = createDeferred<ProbeResponse>();
    const f = openReader({ ...options, probe: probe.promise });
    expectPending(f);
    probe.resolve(response ?? { status: 401 });
    await probe.promise;
    if (redirect) {
      expect(f.replace).toHaveBeenCalledWith(redirect);
      expect(f.document.querySelector("main")!.hasAttribute("data-entry-pending")).toBe(true);
    } else {
      expectUnavailable(f);
    }
    expect(f.fetch).toHaveBeenCalledWith(
      (redirect ?? entry).split("#")[0] + "&probe=1",
      expect.objectContaining({ credentials: "same-origin", redirect: "manual" }),
    );
  });
});
