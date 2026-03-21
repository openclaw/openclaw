import type { GatewayBrowserClient } from "../gateway.ts";

export type BrowserTab = {
  targetId: string;
  url: string;
  title: string;
};

export type BrowserProfile = {
  name: string;
  running: boolean;
  driver?: string;
  color?: string;
  tabs: BrowserTab[];
};

export type BrowserState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  browserLoading: boolean;
  browserError: string | null;
  browserProfiles: BrowserProfile[];
  browserPollInterval: number | null;
};

async function browserRequest(
  client: GatewayBrowserClient,
  method: "GET" | "POST" | "DELETE",
  path: string,
  opts?: { query?: Record<string, string>; body?: unknown },
): Promise<unknown> {
  return client.request("browser.request", {
    method,
    path,
    query: opts?.query,
    body: opts?.body,
  });
}

export async function loadBrowserSessions(state: BrowserState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.browserLoading) {
    return;
  }
  state.browserLoading = true;
  state.browserError = null;
  try {
    // 1. Get all profiles
    const profilesRes = (await browserRequest(state.client, "GET", "/profiles")) as {
      profiles?: Array<{ name: string; driver?: string; color?: string }>;
    };
    const profiles = profilesRes?.profiles ?? [];

    // 2. For each profile, get tabs
    const results = await Promise.all(
      profiles.map(async (p) => {
        try {
          const tabsRes = (await browserRequest(state.client!, "GET", "/tabs", {
            query: { profile: p.name },
          })) as { running?: boolean; tabs?: BrowserTab[] };
          return {
            name: p.name,
            running: tabsRes?.running ?? false,
            driver: p.driver,
            color: p.color,
            tabs: (tabsRes?.tabs ?? []).map((t) => ({
              targetId: t.targetId ?? "",
              url: t.url ?? "",
              title: t.title ?? t.url ?? "",
            })),
          } satisfies BrowserProfile;
        } catch {
          return { name: p.name, running: false, driver: p.driver, color: p.color, tabs: [] };
        }
      }),
    );

    state.browserProfiles = results;
  } catch (err) {
    state.browserError = String(err);
    state.browserProfiles = [];
  } finally {
    state.browserLoading = false;
  }
}

export async function openBrowserTab(state: BrowserState, profile: string, url: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.browserError = null;
  try {
    await browserRequest(state.client, "POST", "/tabs/open", {
      body: { profile, url },
    });
    await loadBrowserSessions(state);
  } catch (err) {
    state.browserError = String(err);
  }
}

export async function closeBrowserTab(state: BrowserState, profile: string, targetId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.browserError = null;
  try {
    await browserRequest(state.client, "DELETE", `/tabs/${targetId}`, {
      query: { profile },
    });
    await loadBrowserSessions(state);
  } catch (err) {
    state.browserError = String(err);
  }
}

export async function startBrowserProfile(state: BrowserState, profile: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.browserError = null;
  try {
    await browserRequest(state.client, "POST", "/start", { body: { profile } });
    await loadBrowserSessions(state);
  } catch (err) {
    state.browserError = String(err);
  }
}

export function startBrowserPolling(state: BrowserState) {
  if (state.browserPollInterval != null) {
    return;
  }
  state.browserPollInterval = window.setInterval(() => {
    void loadBrowserSessions(state);
  }, 8_000) as unknown as number;
}

export function stopBrowserPolling(state: BrowserState) {
  if (state.browserPollInterval == null) {
    return;
  }
  clearInterval(state.browserPollInterval);
  state.browserPollInterval = null;
}
