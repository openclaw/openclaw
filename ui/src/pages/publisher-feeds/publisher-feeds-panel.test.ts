/* @vitest-environment jsdom */

import type {
  PublisherFeedFollow,
  PublisherFeedRefreshStatus,
  PublisherFeedsListResult,
} from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import "./publisher-feeds-panel.ts";

const refreshStatus: PublisherFeedRefreshStatus = {
  running: false,
  stopped: false,
  lastStartedAt: "2026-07-16T20:00:00.000Z",
  lastCompletedAt: "2026-07-16T20:00:01.000Z",
  lastFollowCount: 1,
  lastRefreshedCount: 1,
  lastFailedCount: 0,
};

const follow: PublisherFeedFollow = {
  sourceOrigin: "https://clawhub.ai",
  publisherId: "nvidia",
  feedProfile: "clawhub-public",
  createdAtMs: 1,
  updatedAtMs: 2,
  acceptedSequence: 42,
  displayName: "NVIDIA",
  verifiedAt: "2026-07-16T20:00:01.000Z",
};

type TestPanel = HTMLElement & { updateComplete: Promise<boolean> };

function createGateway(
  handler: (method: string, params: unknown) => Promise<unknown>,
  scopes = ["operator.read", "operator.write"],
  profileDiscovery = false,
) {
  const request = vi.fn(handler);
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    reconnecting: false,
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes },
      features: {
        methods: [
          "publisherFeeds.list",
          "publisherFeeds.follow",
          "publisherFeeds.unfollow",
          "publisherFeeds.refresh",
          ...(profileDiscovery ? ["publisherFeeds.profiles"] : []),
        ],
      },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gateway = {
    snapshot,
    connection: { gatewayUrl: "ws://localhost", token: "", password: "", bootstrapToken: "" },
    eventLog: [],
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe: () => () => undefined,
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } satisfies ApplicationGateway;
  return { gateway, request };
}

async function mount(
  gateway: ApplicationGateway,
): Promise<{ panel: TestPanel; provider: ApplicationContextProvider }> {
  const context = { gateway, basePath: "" } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const panel = document.createElement("openclaw-publisher-feeds-panel") as TestPanel;
  provider.append(panel);
  document.body.append(provider);
  await panel.updateComplete;
  return { panel, provider };
}

function listResult(follows: PublisherFeedFollow[] = [follow]): PublisherFeedsListResult {
  return { follows, refresh: refreshStatus };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("PublisherFeedsPanel", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("loads followed publishers and renders verified state", async () => {
    const { gateway, request } = createGateway(async () => listResult());
    const { panel } = await mount(gateway);

    await vi.waitFor(() => expect(panel.textContent).toContain("NVIDIA"));
    expect(panel.textContent).toContain("Sequence 42");
    expect(panel.textContent).toContain("1 of 1 refreshed");
    expect(request).toHaveBeenCalledWith("publisherFeeds.list", {});
  });

  it("discovers signed profiles and prefers the ClawHub default", async () => {
    const { gateway } = createGateway(
      async (method) => {
        if (method === "publisherFeeds.profiles") {
          return {
            profiles: [
              { name: "partner", sourceOrigin: "https://partner.example" },
              { name: "clawhub-public", sourceOrigin: "https://clawhub.ai" },
            ],
          };
        }
        return listResult([]);
      },
      undefined,
      true,
    );
    const { panel } = await mount(gateway);

    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLSelectElement>('select[name="feed-profile"]')?.value).toBe(
        "clawhub-public",
      ),
    );
    const profileSelect = panel.querySelector<HTMLSelectElement>('select[name="feed-profile"]');
    expect(profileSelect?.textContent).toContain("partner · https://partner.example");
    expect(panel.querySelector('input[name="feed-profile"]')).toBeNull();
  });

  it("does not permit follows when no signed profiles are configured", async () => {
    const { gateway } = createGateway(
      async (method) => (method === "publisherFeeds.profiles" ? { profiles: [] } : listResult([])),
      undefined,
      true,
    );
    const { panel } = await mount(gateway);

    await vi.waitFor(() =>
      expect(panel.textContent).toContain("No signed feed profiles configured"),
    );
    expect(panel.querySelector<HTMLSelectElement>('select[name="feed-profile"]')?.disabled).toBe(
      true,
    );
    expect(panel.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });

  it("keeps the selected and submitted profile aligned after discovery changes", async () => {
    let profileLoads = 0;
    const { gateway, request } = createGateway(
      async (method) => {
        if (method === "publisherFeeds.profiles") {
          profileLoads += 1;
          return {
            profiles:
              profileLoads === 1
                ? [
                    { name: "partner", sourceOrigin: "https://partner.example" },
                    { name: "clawhub-public", sourceOrigin: "https://clawhub.ai" },
                  ]
                : [{ name: "clawhub-public", sourceOrigin: "https://clawhub.ai" }],
          };
        }
        if (method === "publisherFeeds.refresh") {
          return { status: refreshStatus };
        }
        if (method === "publisherFeeds.follow") {
          return { follow };
        }
        return listResult([]);
      },
      undefined,
      true,
    );
    const { panel } = await mount(gateway);
    const profileSelect = await vi.waitFor(() => {
      const select = panel.querySelector<HTMLSelectElement>('select[name="feed-profile"]');
      expect(select?.value).toBe("clawhub-public");
      return select;
    });
    if (!profileSelect) {
      throw new Error("profile select was not rendered");
    }
    profileSelect.value = "partner";
    profileSelect.dispatchEvent(new Event("change", { bubbles: true }));
    panel.querySelector<HTMLButtonElement>('[aria-label="Refresh publisher feeds"]')?.click();

    await vi.waitFor(() => expect(profileSelect.value).toBe("clawhub-public"));
    const publisherInput = panel.querySelector<HTMLInputElement>('[name="publisher-id"]');
    if (!publisherInput) {
      throw new Error("publisher id input was not rendered");
    }
    publisherInput.value = "nvidia";
    publisherInput.dispatchEvent(new Event("input", { bubbles: true }));
    panel.querySelector<HTMLFormElement>("form")?.requestSubmit();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("publisherFeeds.follow", {
        publisherId: "nvidia",
        feedProfile: "clawhub-public",
      }),
    );
  });

  it("blocks mutations until the current list request completes", async () => {
    const pendingList = deferred<PublisherFeedsListResult>();
    const { gateway, request } = createGateway(async (method) => {
      if (method === "publisherFeeds.list") {
        return pendingList.promise;
      }
      return { follow };
    });
    const { panel } = await mount(gateway);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("publisherFeeds.list", {}));

    const publisherInput = panel.querySelector<HTMLInputElement>('[name="publisher-id"]');
    const profileInput = panel.querySelector<HTMLInputElement>('[name="feed-profile"]');
    if (!publisherInput || !profileInput) {
      throw new Error("publisher feed inputs were not rendered");
    }
    publisherInput.value = "nvidia";
    publisherInput.dispatchEvent(new Event("input", { bubbles: true }));
    profileInput.value = "clawhub-public";
    profileInput.dispatchEvent(new Event("input", { bubbles: true }));
    await panel.updateComplete;

    expect(panel.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    panel.querySelector<HTMLFormElement>("form")?.requestSubmit();
    expect(request).not.toHaveBeenCalledWith("publisherFeeds.follow", expect.anything());

    pendingList.resolve(listResult([]));
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false),
    );
  });

  it("disables mutations for read-only operators", async () => {
    const { gateway, request } = createGateway(async () => listResult(), ["operator.read"]);
    const { panel } = await mount(gateway);
    await vi.waitFor(() => expect(panel.textContent).toContain("NVIDIA"));

    expect(panel.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(
      panel.querySelector<HTMLButtonElement>('[aria-label="Refresh publisher feeds"]')?.disabled,
    ).toBe(true);
    expect(panel.querySelector<HTMLButtonElement>('[aria-label="Unfollow NVIDIA"]')?.disabled).toBe(
      true,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("follows, refreshes, and unfollows through advertised methods", async () => {
    let follows: PublisherFeedFollow[] = [];
    const { gateway, request } = createGateway(async (method) => {
      if (method === "publisherFeeds.follow") {
        follows = [follow];
        return { follow };
      }
      if (method === "publisherFeeds.unfollow") {
        follows = [];
        return { removed: true };
      }
      if (method === "publisherFeeds.refresh") {
        return { status: refreshStatus };
      }
      return listResult(follows);
    });
    const { panel } = await mount(gateway);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("publisherFeeds.list", {}));

    const publisherInput = panel.querySelector<HTMLInputElement>('[name="publisher-id"]');
    const profileInput = panel.querySelector<HTMLInputElement>('[name="feed-profile"]');
    if (!publisherInput || !profileInput) {
      throw new Error("publisher feed inputs were not rendered");
    }
    publisherInput.value = "nvidia";
    publisherInput.dispatchEvent(new Event("input", { bubbles: true }));
    profileInput.value = "clawhub-public";
    profileInput.dispatchEvent(new Event("input", { bubbles: true }));
    await panel.updateComplete;
    panel.querySelector<HTMLFormElement>("form")?.requestSubmit();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("publisherFeeds.follow", {
        publisherId: "nvidia",
        feedProfile: "clawhub-public",
      }),
    );
    await vi.waitFor(() => expect(panel.textContent).toContain("NVIDIA"));

    panel.querySelector<HTMLButtonElement>('[aria-label="Refresh publisher feeds"]')?.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("publisherFeeds.refresh", {}));

    await vi.waitFor(() => {
      expect(
        panel.querySelector<HTMLButtonElement>('[aria-label="Unfollow NVIDIA"]')?.disabled,
      ).toBe(false);
    });
    panel.querySelector<HTMLButtonElement>('[aria-label="Unfollow NVIDIA"]')?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("publisherFeeds.unfollow", {
        publisherId: "nvidia",
        feedProfile: "clawhub-public",
      }),
    );
    await vi.waitFor(() => expect(panel.textContent).toContain("No publisher feeds followed."));
  });

  it("shows request failures without discarding the surface", async () => {
    const { gateway } = createGateway(async () => {
      throw new Error("feed database unavailable");
    });
    const { panel } = await mount(gateway);

    await vi.waitFor(() => expect(panel.querySelector('[role="alert"]')).not.toBeNull());
    expect(panel.textContent).toContain("feed database unavailable");
    expect(panel.querySelector("form")).not.toBeNull();
  });
});
