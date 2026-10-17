import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

const workerSource = fs.readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
function loadWorker<Event>(
  self: Record<string, unknown>,
  globals: Record<string, unknown> = {},
  source = workerSource,
) {
  const listeners = new Map<string, (event: Event) => void>();
  new vm.Script(source, { filename: "ui/public/sw.js" }).runInNewContext({
    URL,
    ...globals,
    self: {
      ...self,
      addEventListener: (type: string, listener: (event: Event) => void) =>
        listeners.set(type, listener),
    },
  });
  return listeners;
}

type LifetimeEvent = { waitUntil(promise: Promise<unknown>): void };

function dispatch<Event>(
  listener: ((event: Event & LifetimeEvent) => void) | undefined,
  event: Event,
) {
  let completion: Promise<unknown> | undefined;
  listener?.({
    ...event,
    waitUntil: (pending) => {
      completion = pending;
    },
  });
  if (!completion) {
    throw new Error("Service worker did not register a completion promise");
  }
  return completion;
}

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
  const cacheDelete = vi.fn(async () => true);
  const cacheNames = ["oldest", "older", "previous", "new-build"].map(
    (version) => `openclaw-control-${version}`,
  );
  const clients = {
    claim: vi.fn(async () => undefined),
    matchAll: vi.fn(async () => [...included, ...excluded]),
  };
  const listeners = loadWorker<LifetimeEvent>(
    {
      clients,
      location: { href: "https://control.example/openclaw/sw.js?v=new-build" },
      registration: { scope: "https://control.example/openclaw/" },
    },
    {
      caches: {
        delete: cacheDelete,
        match: async (_url: string, { cacheName }: { cacheName: string }) =>
          cacheName.startsWith("openclaw-control-") ? {} : undefined,
        keys: async () => [...cacheNames, "other-cache"],
      },
    },
  );
  await expect(dispatch(listeners.get("activate"), {})).resolves.toBeUndefined();
  expect(clients.claim).toHaveBeenCalledBefore(clients.matchAll);
  expect(cacheDelete.mock.calls).toEqual(cacheNames.slice(0, 2).map((name) => [name]));
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
  const reply = vi.fn();
  const source = workerSource.replace(
    'const EMBEDDED_CACHE_VERSION = "__OPENCLAW_CONTROL_UI_BUILD_ID__";',
    'const EMBEDDED_CACHE_VERSION = "new-build";',
  );
  const listeners = loadWorker<{ data: unknown; ports: unknown[] }>(
    {
      location: { href: "https://control.example/sw.js?v=old-build" },
      registration: { scope: "https://control.example/" },
    },
    {},
    source,
  );
  listeners.get("message")?.({
    data: { type: "sw-version-probe" },
    ports: [{ postMessage: reply }],
  });
  expect(reply).toHaveBeenCalledExactlyOnceWith({ type: "sw-updated", version: "new-build" });
});
const root = "https://control.example/";
const nested = root + "openclaw/";
const slashless = root + "openclaw";

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
const settings = `${nested}settings`;
const latest = `${nested}${latestRoute}`;
const current = `${nested}${currentRoute}`;
const stale = `${nested}chat?session=7`;
const sibling = "https://control.example/openclaw-other/chat";
const approval = "approve/exec%3A1#gatewayUrl=wss%3A%2F%2Fgateway.example";
const preserved: Array<[string, string, string, boolean?]> = [
  ["root", root, root + currentQuery],
  ["nested child", nested, nested + "chat" + currentQuery],
  ["slashless", slashless, slashless + currentQuery],
  ["slashless child", slashless, nested + "chat" + currentQuery],
  ["legacy root", root, root + currentQuery, true],
  ["legacy slashless", slashless, nested + "chat" + currentQuery, true],
];
const rejected: Array<[string, string, string[], string?]> = [
  ["cross-origin window", nested, ["https://outside.example/openclaw/"]],
  ["sibling-prefix window", nested, ["https://control.example/openclaw-other/"]],
  ["sibling target", nested, [sibling], "/openclaw-other/chat"],
  ["slashless sibling target", slashless, [sibling], "/openclaw-other/chat"],
  ["ancestor traversal", slashless, [root], "../"],
];
const scenarios: NotificationClickScenario[] = [
  ...preserved.map(([name, scope, url, legacy]) =>
    scenario(`preserves ${name} query-state`, scope, [url], { legacy }),
  ),
  ...rejected.map(([name, scope, urls, target]) =>
    scenario(`rejects ${name}`, scope, urls, {
      target: target ?? null,
      focusedClientIndex: -1,
      openedUrl: scope,
    }),
  ),
  scenario("prefers nested scope over root", nested, [root, nested], { focusedClientIndex: 1 }),
  ...[
    { name: "exact target over unrelated tab", urls: [settings, latest] },
    { name: "exact target over stale fragment", urls: [current + "#previous", latest] },
    { name: "matching query over unrelated tab", urls: [settings, current] },
    { name: "matching path over unrelated tab", urls: [settings, stale] },
  ].map(({ name, urls }) =>
    scenario(name, nested, urls, {
      target: latestRoute,
      focusedClientIndex: 1,
      navigatedUrl: latest,
    }),
  ),
  scenario("opens exact empty slashless scope", slashless, []),
  ...(
    [
      ["opens approval with Gateway handoff", nested, approval, nested + approval],
      ["opens relative target beneath slashless scope", slashless, latestRoute, latest],
      ["rejects cross-origin target", nested, "https://outside.example/openclaw/chat", nested],
      ["rejects malformed target", nested, "https://[invalid", nested],
    ] satisfies Array<[string, string, string, string]>
  ).map(([name, scope, target, openedUrl]) => scenario(name, scope, [], { target, openedUrl })),
  ...[
    { name: "navigates past stale SPA fragments", url: nested + "chat" + currentQuery },
    { name: "navigates legacy exact target", url: stale, legacy: true },
  ].map(({ name, url, legacy }) =>
    scenario(name, nested, [url], { target: currentRoute, navigatedUrl: current, legacy }),
  ),
  scenario("prefers legacy matching tab", nested, [settings, current], {
    legacy: true,
    target: currentRoute,
    focusedClientIndex: 1,
    navigatedUrl: current,
  }),
  scenario("opens target after legacy navigation rejection", nested, [stale], {
    legacy: true,
    rejectNavigation: true,
    target: latestRoute,
    navigatedClientIndex: 0,
    focusedClientIndex: -1,
    navigatedUrl: latest,
    openedUrl: latest,
  }),
];

it.each(scenarios)("$name", async (row) => {
  const worker = createNotificationServiceWorker(row.scope, row.clientUrls, row);
  let data: { url: string; explicitUrl?: boolean } = { url: row.target ?? "./" };
  if (!row.legacy) {
    const notification = await worker.dispatchPush(row.target === null ? {} : { url: row.target });
    expect(notification).toMatchObject({
      title: "OpenClaw",
      options: {
        body: "Scoped notification",
        data: { url: row.target ?? row.scope, explicitUrl: row.target !== null },
      },
    });
    data = notification.options.data;
  }
  const close = await worker.dispatchNotificationClick(data);

  expect(close).toHaveBeenCalledOnce();
  expect(worker.clients.matchAll).toHaveBeenCalledWith({
    type: "window",
    includeUncontrolled: true,
  });

  for (const [index, client] of worker.windowClients.entries()) {
    expect(client.focus.mock.calls).toHaveLength(index === row.focusedClientIndex ? 1 : 0);
    const navigates =
      index === (row.navigatedClientIndex ?? row.focusedClientIndex) && row.navigatedUrl;
    expect(client.navigate.mock.calls).toEqual(navigates ? [[row.navigatedUrl]] : []);
  }

  expect(worker.clients.openWindow.mock.calls).toEqual(
    row.openedUrl === null ? [] : [[row.openedUrl]],
  );
});

it("preserves a quiet shared tag for approval terminal replacements", async () => {
  const worker = createNotificationServiceWorker(nested, []);
  const replacement = { tag: "openclaw-approval-exec:replacement", renotify: false };
  const requested = await worker.dispatchPush({ title: "Approval requested", ...replacement });
  const terminal = await worker.dispatchPush({ title: "Approval updated", ...replacement });
  expect([requested.options, terminal.options]).toEqual([
    expect.objectContaining(replacement),
    expect.objectContaining(replacement),
  ]);
});

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

type PushPayload = {
  title: string;
  body: string;
  renotify?: boolean;
  tag?: string;
  url?: string;
  icon?: string;
};

type ServiceWorkerNotificationOptions = Required<Omit<PushPayload, "title" | "url">> & {
  badge: string;
  data: { url: string; explicitUrl: boolean };
};

type ServiceWorkerNotificationEventStub = {
  data?: {
    json(): PushPayload;
    text(): string;
  };
  notification?: {
    close(): void;
    data: { url: string; explicitUrl?: boolean };
  };
};

function createNotificationServiceWorker(
  scope: string,
  clientUrls: string[],
  options: { rejectNavigation?: boolean } = {},
) {
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
  const listeners = loadWorker<ServiceWorkerNotificationEventStub & LifetimeEvent>({
    clients,
    location: { href: new URL("sw.js?v=notification-scope", scope).href },
    registration: { scope, showNotification },
  });

  return {
    clients,
    windowClients,
    async dispatchPush(overrides: Partial<PushPayload> = {}) {
      const payload = { title: "OpenClaw", body: "Scoped notification", ...overrides };
      await dispatch<ServiceWorkerNotificationEventStub>(listeners.get("push"), {
        data: { json: () => payload, text: () => payload.body },
      });
      const notification = showNotification.mock.calls.at(-1);
      assert(notification, "Service worker push did not show a notification");
      return { title: notification[0], options: notification[1] };
    },
    async dispatchNotificationClick(data: { url: string; explicitUrl?: boolean }) {
      const close = vi.fn();
      await dispatch<ServiceWorkerNotificationEventStub>(listeners.get("notificationclick"), {
        notification: { close, data },
      });
      return close;
    },
  };
}

it.each([
  ["data:image/png;base64,iVBORw0KGgo=", true],
  ["https://example.test/avatar.png", false],
  ["data:image/svg+xml,<svg/>", false],
  [`data:image/png;base64,${"A".repeat(2_400)}`, false],
])("accepts only bounded inline raster icons (%s)", async (icon, accepted) => {
  const worker = createNotificationServiceWorker("https://gateway.example.test/control/", []);
  const notification = await worker.dispatchPush({ icon });
  expect(notification.options).toMatchObject({
    icon: accepted ? icon : "./apple-touch-icon.png",
    badge: "./favicon-32.png",
  });
});
