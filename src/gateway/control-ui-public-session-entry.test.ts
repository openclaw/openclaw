import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { renderPublicSessionDocument } from "./control-ui-public-session-render.js";

const readers: JSDOM[] = [];
afterEach(() => readers.splice(0).forEach((dom) => dom.window.close()));

function openReader(
  options: {
    url?: string;
    basePath?: string;
    clientAuth?: boolean;
    token?: string;
    device?: string;
    storedScope?: string;
    probeStatus?: number;
    probe?: Promise<{ status: number }>;
    unavailable?: boolean;
    blockedStorage?: boolean;
  } = {},
) {
  const basePath = options.basePath ?? "/control";
  const dom = new JSDOM(
    renderPublicSessionDocument({
      title: "Conversation unavailable",
      messages: [],
      truncated: false,
      unavailable: options.unavailable !== false,
      latestUrl: "/control/chat/main/private",
      cardUrl: "https://gateway.test/control/share/card.png",
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
  const fetch = vi
    .fn()
    .mockReturnValue(options.probe ?? Promise.resolve({ status: options.probeStatus ?? 401 }));
  const storage = options.blockedStorage
    ? {
        getItem() {
          throw new Error("Storage blocked");
        },
      }
    : undefined;
  runInNewContext(document.querySelector("script")!.textContent!, {
    document,
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
  return { replace, fetch, document, loginVisibility };
}

const device = JSON.stringify({
  version: 1,
  deviceId: "synthetic-device",
  tokens: {
    operator: {
      token: "synthetic-device-token",
      role: "operator",
      scopes: ["operator.read"],
      updatedAtMs: 1,
    },
  },
});
const entry =
  "https://gateway.test/control/__openclaw__/session-entry?path=%2Fcontrol%2Fchat%2Fmain%2Fprivate";

describe("public reader operator handoff", () => {
  it.each([204, 401])(
    "keeps the unavailable result pending through a delayed %s handoff",
    async (status) => {
      const probe = createDeferred<{ status: number }>();
      const f = openReader({ probe: probe.promise, token: "synthetic-token" });
      const main = f.document.querySelector("main")!;
      expect(main.hasAttribute("data-entry-pending")).toBe(true);
      expect(f.document.title).not.toContain("unavailable");
      expect(f.loginVisibility()).toBe("hidden");
      expect(f.replace).not.toHaveBeenCalled();
      probe.resolve({ status });
      await probe.promise;
      expect(f.replace).toHaveBeenCalledWith(entry);
      expect(main.hasAttribute("data-entry-pending")).toBe(true);
    },
  );

  it.each([401, 403])(
    "reveals confirmed unavailability after a delayed %s response",
    async (status) => {
      const probe = createDeferred<{ status: number }>();
      const f = openReader({ probe: probe.promise });
      const main = f.document.querySelector("main")!;
      expect(main.hasAttribute("data-entry-pending")).toBe(true);
      probe.resolve({ status });
      await probe.promise;
      expect(main.hasAttribute("data-entry-pending")).toBe(false);
      expect(f.document.title).toBe("Conversation unavailable · OpenClaw");
      expect(f.loginVisibility()).toBe("visible");
      expect(f.replace).not.toHaveBeenCalled();
    },
  );

  it.each(["network", "timeout", "server"])(
    "does not present %s failures as denied access",
    async (kind) => {
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
    },
  );

  it("leaves a public transcript readable while the optional handoff is pending", () => {
    const probe = createDeferred<{ status: number }>();
    const f = openReader({ probe: probe.promise, unavailable: false });
    expect(f.document.querySelector("main")!.hasAttribute("data-entry-pending")).toBe(false);
    expect(f.document.querySelector(".transcript")).not.toBeNull();
    expect(f.document.querySelector(".entry-status")).toBeNull();
  });

  it.each([
    { name: "session token on reload", token: "synthetic-token" },
    { name: "paired token/password device in a new tab", device },
    {
      name: "paired device with an existing Gateway query scope",
      device,
      storedScope: "wss://gateway.test/control?account=work",
    },
    {
      name: "explicit token fragment",
      url: "https://gateway.test/control/chat/main/private#token=synthetic-token",
    },
  ])("opens the app automatically with $name", async (options) => {
    const f = openReader(options);
    await Promise.resolve();
    expect(f.replace).toHaveBeenCalledWith(entry + (options.url ? "#token=synthetic-token" : ""));
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the loopback page and mounted gateway, preserving the fragment", async () => {
    const f = openReader({
      url: "http://127.0.0.1:12345/control/chat/main/private#message-42",
      device,
    });
    await Promise.resolve();
    expect(f.replace).toHaveBeenCalledWith(
      entry.replace("https://gateway.test", "http://127.0.0.1:12345") + "#message-42",
    );
  });

  it("recognizes the default root-mounted Gateway credential", async () => {
    const f = openReader({ basePath: "", url: "http://127.0.0.1:12345/chat/main/private", device });
    await Promise.resolve();
    expect(f.replace).toHaveBeenCalledWith(
      "http://127.0.0.1:12345/__openclaw__/session-entry?path=%2Fchat%2Fmain%2Fprivate",
    );
  });

  it.each([
    { name: "anonymous visitor" },
    { name: "empty token", token: " " },
    {
      name: "another gateway",
      token: "synthetic-token",
      device,
      storedScope: "wss://other.test/control",
    },
    {
      name: "another mount",
      token: "synthetic-token",
      device,
      storedScope: "wss://gateway.test/other",
    },
    {
      name: "another mount with a Gateway query scope",
      device,
      storedScope: "wss://gateway.test/control-other?account=work",
    },
    {
      name: "another scheme",
      token: "synthetic-token",
      device,
      storedScope: "ws://gateway.test/control",
    },
    { name: "malformed storage", device: "not-json" },
    { name: "cleared device token", device: '{"tokens":{}}' },
    { name: "blocked storage", blockedStorage: true },
    {
      name: "denied HTTP identity in token mode",
      token: "synthetic-token",
      device,
      probeStatus: 403,
    },
    {
      name: "denied proxy identity with stale local credentials",
      clientAuth: false,
      token: "synthetic-token",
      device,
      probeStatus: 403,
    },
  ])("keeps $name on the reader", async (options) => {
    const f = openReader(options);
    await Promise.resolve();
    expect(f.replace).not.toHaveBeenCalled();
    expect(f.document.querySelector("main")!.hasAttribute("data-entry-pending")).toBe(false);
    expect(f.document.title).toBe("Conversation unavailable · OpenClaw");
    expect(f.fetch).toHaveBeenCalledWith(
      `${entry}&probe=1`,
      expect.objectContaining({ credentials: "same-origin", redirect: "error" }),
    );
  });

  it("keeps the authenticated proxy probe handoff", async () => {
    const f = openReader({ clientAuth: false, probeStatus: 204 });
    await Promise.resolve();
    expect(f.replace).toHaveBeenCalledWith(entry);
  });
});
