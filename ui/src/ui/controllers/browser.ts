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
  browserNewTabUrl: string;
  browserNewTabProfile: string | null;
  browserNewProfileName: string;
  browserActionBusy: boolean;
  browserAutoRefreshActive: boolean;
  browserTappedTabs: Set<string>;
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

    // Auto-select the first running profile if none is selected
    if (
      !state.browserNewTabProfile ||
      !results.some((p) => p.name === state.browserNewTabProfile)
    ) {
      const firstRunning = results.find((p) => p.running);
      state.browserNewTabProfile = firstRunning?.name ?? results[0]?.name ?? null;
    }
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
  state.browserActionBusy = true;
  state.browserError = null;
  try {
    await browserRequest(state.client, "POST", "/tabs/open", {
      body: { profile, url },
    });
    await loadBrowserSessions(state);
  } catch (err) {
    state.browserError = String(err);
  } finally {
    state.browserActionBusy = false;
  }
}

export async function closeBrowserTab(state: BrowserState, profile: string, targetId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.browserActionBusy = true;
  state.browserError = null;
  try {
    await browserRequest(state.client, "DELETE", `/tabs/${targetId}`, {
      query: { profile },
    });
    // Remove from tapped set if present
    if (state.browserTappedTabs.has(targetId)) {
      const next = new Set(state.browserTappedTabs);
      next.delete(targetId);
      state.browserTappedTabs = next;
    }
    await loadBrowserSessions(state);
  } catch (err) {
    state.browserError = String(err);
  } finally {
    state.browserActionBusy = false;
  }
}

export async function focusBrowserTab(state: BrowserState, profile: string, targetId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.browserError = null;
  try {
    await browserRequest(state.client, "POST", `/tabs/focus`, {
      body: { profile, targetId },
    });
  } catch (err) {
    state.browserError = String(err);
  }
}

export async function startBrowserProfile(state: BrowserState, profile: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.browserActionBusy = true;
  state.browserError = null;
  try {
    await browserRequest(state.client, "POST", "/start", { body: { profile } });
    await loadBrowserSessions(state);
  } catch (err) {
    state.browserError = String(err);
  } finally {
    state.browserActionBusy = false;
  }
}

export async function stopBrowserProfile(state: BrowserState, profile: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.browserActionBusy = true;
  state.browserError = null;
  try {
    await browserRequest(state.client, "POST", "/stop", { body: { profile } });
    await loadBrowserSessions(state);
  } catch (err) {
    state.browserError = String(err);
  } finally {
    state.browserActionBusy = false;
  }
}

export async function createBrowserProfile(state: BrowserState, name: string) {
  if (!state.client || !state.connected || !name.trim()) {
    return;
  }
  state.browserActionBusy = true;
  state.browserError = null;
  try {
    await browserRequest(state.client, "POST", "/profiles/create", {
      body: { name: name.trim() },
    });
    state.browserNewProfileName = "";
    await loadBrowserSessions(state);
  } catch (err) {
    state.browserError = String(err);
  } finally {
    state.browserActionBusy = false;
  }
}

export async function deleteBrowserProfile(state: BrowserState, name: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.browserActionBusy = true;
  state.browserError = null;
  try {
    await browserRequest(state.client, "DELETE", `/profiles/${encodeURIComponent(name)}`);
    if (state.browserNewTabProfile === name) {
      state.browserNewTabProfile = null;
    }
    await loadBrowserSessions(state);
  } catch (err) {
    state.browserError = String(err);
  } finally {
    state.browserActionBusy = false;
  }
}

/** Open the tab URL in a new browser window — signals "human is taking over" */
export function tapInBrowserTab(state: BrowserState, tab: BrowserTab) {
  window.open(tab.url, "_blank", "noopener,noreferrer");
  const next = new Set(state.browserTappedTabs);
  next.add(tab.targetId);
  state.browserTappedTabs = next;
}

/** Remove the "Human Viewing" badge — agent can resume */
export function tapOutBrowserTab(state: BrowserState, targetId: string) {
  const next = new Set(state.browserTappedTabs);
  next.delete(targetId);
  state.browserTappedTabs = next;
}

export function startBrowserPolling(state: BrowserState) {
  if (state.browserPollInterval != null) {
    return;
  }
  state.browserAutoRefreshActive = true;
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
  state.browserAutoRefreshActive = false;
}
