// Service-worker activation and notification lifecycle contracts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerPath = path.join(here, "../../public/sw.js");

describe("Control UI service worker cache versioning", () => {
  it("announces only to legacy root/chat clients without reloading older settings tabs", async () => {
    const client = (url: string) => ({ url, postMessage: vi.fn(), navigate: vi.fn() });
    const included = [
      client("https://control.example/openclaw/"),
      client("https://control.example/openclaw/chat/main/session?mode=compact#latest"),
    ];
    const excluded = [
      client("https://control.example/openclaw/settings/appearance"),
      client("https://control.example/openclaw/config?raw=1#editor"),
      client("https://control.example/openclaw-other/chat"),
      client("https://other.example/openclaw/chat/main/session"),
    ];
    const listeners = new Map<string, (event: ActivateEventStub) => void>();
    const cacheDelete = vi.fn(async () => true);
    const clients = {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => [...included, ...excluded]),
    };
    const context = vm.createContext({
      URL,
      caches: {
        delete: cacheDelete,
        keys: async () => [
          "openclaw-control-oldest",
          "openclaw-control-older",
          "openclaw-control-previous",
          "openclaw-control-new-build",
          "other-cache",
        ],
      },
      self: {
        addEventListener: (type: string, listener: (event: ActivateEventStub) => void) =>
          listeners.set(type, listener),
        clients,
        location: { href: "https://control.example/openclaw/sw.js?v=new-build" },
        registration: { scope: "https://control.example/openclaw/" },
      },
    });
    new vm.Script(fs.readFileSync(serviceWorkerPath, "utf8")).runInContext(context);
    let activation: Promise<unknown> | undefined;
    listeners.get("activate")?.({
      waitUntil: (pending) => {
        activation = pending;
      },
    });
    await expect(activation).resolves.toBeUndefined();
    expect(clients.claim).toHaveBeenCalledBefore(clients.matchAll);
    expect(cacheDelete.mock.calls).toEqual([
      ["openclaw-control-oldest"],
      ["openclaw-control-older"],
      ["openclaw-control-previous"],
    ]);
    for (const page of included) {
      expect(page.postMessage).toHaveBeenCalledExactlyOnceWith(
        { type: "sw-updated", version: "new-build" },
        [],
      );
      expect(page.navigate).not.toHaveBeenCalled();
    }
    for (const page of excluded) {
      expect(page.postMessage).not.toHaveBeenCalled();
      expect(page.navigate).not.toHaveBeenCalled();
    }
  });

  it("answers a resumed document from embedded build identity, not the registering URL", () => {
    const listeners = new Map<string, (event: { data: unknown; ports: unknown[] }) => void>();
    const reply = vi.fn();
    const source = fs
      .readFileSync(serviceWorkerPath, "utf8")
      .replace(
        'const EMBEDDED_CACHE_VERSION = "__OPENCLAW_CONTROL_UI_BUILD_ID__";',
        'const EMBEDDED_CACHE_VERSION = "new-build";',
      );
    new vm.Script(source).runInNewContext({
      URL,
      self: {
        addEventListener: (
          type: string,
          listener: (event: { data: unknown; ports: unknown[] }) => void,
        ) => listeners.set(type, listener),
        location: { href: "https://control.example/sw.js?v=old-build" },
        registration: { scope: "https://control.example/" },
      },
    });
    listeners.get("message")?.({
      data: { type: "sw-version-probe" },
      ports: [{ postMessage: reply }],
    });
    expect(reply).toHaveBeenCalledExactlyOnceWith({ type: "sw-updated", version: "new-build" });
  });
});

describe("Control UI service worker notification scope", () => {
  const rootScope = "https://control.example/";
  const nestedScope = "https://control.example/openclaw/";
  const nestedScopeWithoutSlash = "https://control.example/openclaw";

  function scenario(
    name: string,
    scope: string,
    clientUrls: string[],
    options: Partial<Omit<NotificationClickScenario, "name" | "scope" | "clientUrls">> = {},
  ): NotificationClickScenario {
    return {
      name,
      scope,
      target: null,
      clientUrls,
      focusedClientIndex: clientUrls.length > 0 ? 0 : -1,
      openedUrl: clientUrls.length > 0 ? null : scope,
      ...options,
    };
  }

  const currentQuery = "?session=42#current-session";
  const latestRoute = "chat?session=42#latest";
  const currentRoute = "chat?session=42";
  const settings = `${nestedScope}settings`;
  const latest = `${nestedScope}${latestRoute}`;
  const current = `${nestedScope}${currentRoute}`;
  const stale = `${nestedScope}chat?session=7`;
  const sibling = "https://control.example/openclaw-other/chat";
  const approval = "approve/exec%3A1#gatewayUrl=wss%3A%2F%2Fgateway.example";
  const scenarios: NotificationClickScenario[] = [
    scenario("preserves root query-state", rootScope, [rootScope + currentQuery]),
    scenario("preserves nested child query-state", nestedScope, [
      nestedScope + "chat" + currentQuery,
    ]),
    scenario("preserves slashless query-state", nestedScopeWithoutSlash, [
      nestedScopeWithoutSlash + currentQuery,
    ]),
    scenario("preserves slashless child query-state", nestedScopeWithoutSlash, [
      nestedScope + "chat" + currentQuery,
    ]),
    scenario("prefers nested scope over root", nestedScope, [rootScope, nestedScope], {
      focusedClientIndex: 1,
    }),
    scenario("opens approval with Gateway handoff", nestedScope, [], {
      target: approval,
      openedUrl: nestedScope + approval,
    }),
    ...[
      { name: "exact target over unrelated tab", urls: [settings, latest] },
      { name: "exact target over stale fragment", urls: [current + "#previous", latest] },
      { name: "matching query over unrelated tab", urls: [settings, current] },
      { name: "matching path over unrelated tab", urls: [settings, stale] },
    ].map(({ name, urls }) =>
      scenario(name, nestedScope, urls, {
        target: latestRoute,
        focusedClientIndex: 1,
        navigatedUrl: latest,
      }),
    ),
    scenario("opens relative target beneath slashless scope", nestedScopeWithoutSlash, [], {
      target: latestRoute,
      openedUrl: latest,
    }),
    scenario(
      "navigates past stale SPA fragments",
      nestedScope,
      [nestedScope + "chat" + currentQuery],
      {
        target: currentRoute,
        navigatedUrl: current,
      },
    ),
    scenario("opens exact empty slashless scope", nestedScopeWithoutSlash, []),
    scenario("excludes cross-origin window", nestedScope, ["https://outside.example/openclaw/"], {
      focusedClientIndex: -1,
      openedUrl: nestedScope,
    }),
    scenario("rejects cross-origin target", nestedScope, [], {
      target: "https://outside.example/openclaw/chat",
    }),
    ...[nestedScope, nestedScopeWithoutSlash].map((scope) =>
      scenario(`rejects sibling target under ${scope}`, scope, [sibling], {
        target: "/openclaw-other/chat",
        focusedClientIndex: -1,
        openedUrl: scope,
      }),
    ),
    scenario("rejects ancestor traversal", nestedScopeWithoutSlash, [rootScope], {
      target: "../",
      focusedClientIndex: -1,
      openedUrl: nestedScopeWithoutSlash,
    }),
    scenario(
      "excludes sibling-prefix window",
      nestedScope,
      ["https://control.example/openclaw-other/"],
      {
        focusedClientIndex: -1,
        openedUrl: nestedScope,
      },
    ),
    scenario("rejects malformed target", nestedScope, [], { target: "https://[invalid" }),
    scenario("preserves legacy root query-state", rootScope, [rootScope + currentQuery], {
      legacy: true,
    }),
    scenario(
      "preserves legacy slashless query-state",
      nestedScopeWithoutSlash,
      [nestedScope + "chat" + currentQuery],
      { legacy: true },
    ),
    scenario("navigates legacy exact target", nestedScope, [stale], {
      legacy: true,
      target: currentRoute,
      navigatedUrl: current,
    }),
    scenario("prefers legacy matching tab", nestedScope, [settings, current], {
      legacy: true,
      target: currentRoute,
      focusedClientIndex: 1,
      navigatedUrl: current,
    }),
    scenario("opens target after legacy navigation rejection", nestedScope, [stale], {
      legacy: true,
      rejectNavigation: true,
      target: latestRoute,
      navigatedClientIndex: 0,
      focusedClientIndex: -1,
      navigatedUrl: latest,
      openedUrl: latest,
    }),
  ];

  it.each(scenarios)(
    "$name",
    async ({
      scope,
      target,
      clientUrls,
      focusedClientIndex,
      navigatedClientIndex,
      navigatedUrl,
      openedUrl,
      legacy,
      rejectNavigation,
    }) => {
      const worker = createNotificationServiceWorker(scope, clientUrls, { rejectNavigation });
      let data: { url: string; explicitUrl?: boolean } = { url: target ?? "./" };
      if (!legacy) {
        const payload: ServiceWorkerPushPayload = {
          title: "OpenClaw",
          body: "Scoped notification",
        };
        if (target !== null) {
          payload.url = target;
        }
        const notification = await worker.dispatchPush(payload);
        expect(notification.title).toBe(payload.title);
        expect(notification.options.body).toBe(payload.body);
        expect(notification.options.data.url).toBe(target ?? scope);
        expect(notification.options.data.explicitUrl).toBe(target !== null);
        data = notification.options.data;
      }
      const close = await worker.dispatchNotificationClick(data);

      expect(close).toHaveBeenCalledOnce();
      expect(worker.clients.matchAll).toHaveBeenCalledWith({
        type: "window",
        includeUncontrolled: true,
      });

      for (const [index, client] of worker.windowClients.entries()) {
        if (index === focusedClientIndex) {
          expect(client.focus).toHaveBeenCalledOnce();
        } else {
          expect(client.focus).not.toHaveBeenCalled();
        }
        if (index === (navigatedClientIndex ?? focusedClientIndex) && navigatedUrl) {
          expect(client.navigate).toHaveBeenCalledExactlyOnceWith(navigatedUrl);
        } else {
          expect(client.navigate).not.toHaveBeenCalled();
        }
      }

      if (openedUrl === null) {
        expect(worker.clients.openWindow).not.toHaveBeenCalled();
      } else {
        expect(worker.clients.openWindow).toHaveBeenCalledExactlyOnceWith(openedUrl);
      }
    },
  );

  it("preserves a quiet shared tag for approval terminal replacements", async () => {
    const worker = createNotificationServiceWorker(nestedScope, []);
    const tag = "openclaw-approval-exec:replacement";

    const requested = await worker.dispatchPush({
      title: "OpenClaw approval requested",
      body: "Open OpenClaw to review this request.",
      tag,
      renotify: false,
    });
    const terminal = await worker.dispatchPush({
      title: "OpenClaw approval updated",
      body: "This approval is no longer pending.",
      tag,
      renotify: false,
    });

    expect(requested.options).toMatchObject({ tag, renotify: false });
    expect(terminal.options).toMatchObject({ tag, renotify: false });
  });
});

type ActivateEventStub = {
  waitUntil(promise: Promise<unknown>): void;
};

type NotificationClickScenario = {
  name: string;
  scope: string;
  target: string | null;
  clientUrls: string[];
  focusedClientIndex: number;
  navigatedClientIndex?: number;
  navigatedUrl?: string;
  openedUrl: string | null;
  legacy?: boolean;
  rejectNavigation?: boolean;
};

type ServiceWorkerPushPayload = {
  title: string;
  body: string;
  renotify?: boolean;
  tag?: string;
  url?: string;
};

type ServiceWorkerNotificationOptions = {
  body: string;
  icon: string;
  badge: string;
  tag: string;
  renotify: boolean;
  data: { url: string; explicitUrl: boolean };
};

type ServiceWorkerNotificationEventStub = {
  data?: {
    json(): ServiceWorkerPushPayload;
    text(): string;
  };
  notification?: {
    close(): void;
    data: { url: string; explicitUrl?: boolean };
  };
  waitUntil(promise: Promise<unknown>): void;
};

function createNotificationServiceWorker(
  scope: string,
  clientUrls: string[],
  options: { rejectNavigation?: boolean } = {},
) {
  const listeners = new Map<string, (event: ServiceWorkerNotificationEventStub) => void>();
  const windowClients = clientUrls.map((url) => {
    const focus = vi.fn(async () => undefined);
    return {
      url,
      focus,
      navigate: vi.fn(async (_url: string) => {
        if (options.rejectNavigation) {
          throw new Error("Window is controlled by a previous service worker");
        }
        return { focus };
      }),
    };
  });
  const clients = {
    matchAll: vi.fn(async () => windowClients),
    openWindow: vi.fn(async (_url: string) => null),
  };
  const showNotification = vi.fn(
    async (_title: string, _options: ServiceWorkerNotificationOptions) => undefined,
  );
  const scopeUrl = new URL(scope);
  const serviceWorkerGlobal = {
    addEventListener(type: string, listener: (event: ServiceWorkerNotificationEventStub) => void) {
      listeners.set(type, listener);
    },
    clients,
    location: {
      href: new URL("sw.js?v=notification-scope", scopeUrl).href,
      origin: scopeUrl.origin,
    },
    registration: { scope, showNotification },
    skipWaiting: vi.fn(),
  };
  const context = vm.createContext({
    URL,
    caches: {},
    fetch: vi.fn(),
    self: serviceWorkerGlobal,
  });

  new vm.Script(fs.readFileSync(serviceWorkerPath, "utf8"), {
    filename: "ui/public/sw.js",
  }).runInContext(context);

  return {
    clients,
    windowClients,
    async dispatchPush(payload: ServiceWorkerPushPayload) {
      const listener = listeners.get("push");
      if (!listener) {
        throw new Error("Service worker did not register a push handler");
      }

      let completion: Promise<unknown> | undefined;
      listener({
        data: {
          json: () => payload,
          text: () => payload.body,
        },
        waitUntil(promise) {
          completion = promise;
        },
      });

      if (!completion) {
        throw new Error("Service worker push did not register a completion promise");
      }
      await completion;

      const notification = showNotification.mock.calls.at(-1);
      if (!notification) {
        throw new Error("Service worker push did not show a notification");
      }

      return { title: notification[0], options: notification[1] };
    },
    async dispatchNotificationClick(data: { url: string; explicitUrl?: boolean }) {
      const listener = listeners.get("notificationclick");
      if (!listener) {
        throw new Error("Service worker did not register a notification-click handler");
      }

      const close = vi.fn();
      let completion: Promise<unknown> | undefined;
      listener({
        notification: { close, data },
        waitUntil(promise) {
          completion = promise;
        },
      });

      if (!completion) {
        throw new Error("Notification click did not register a completion promise");
      }
      await completion;
      return close;
    },
  };
}
