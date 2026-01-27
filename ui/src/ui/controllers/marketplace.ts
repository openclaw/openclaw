import type { GatewayBrowserClient } from "../gateway";

export type MarketplaceSearchResult = {
  slug: string;
  name: string;
  description: string;
  emoji?: string;
  author?: string;
  version: string;
  downloads: number;
  stars: number;
  updatedAt: string;
  tags: string[];
};

export type MarketplaceInstalledSkill = {
  slug: string;
  version: string;
  installedAt: string;
  path: string;
  name?: string;
  description?: string;
  emoji?: string;
};

export type MarketplaceUpdateCheck = {
  slug: string;
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
};

export type MarketplaceMessage = {
  kind: "success" | "error";
  message: string;
};

export type MarketplaceMessageMap = Record<string, MarketplaceMessage>;

export type MarketplaceState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  marketplaceLoading: boolean;
  marketplaceSearching: boolean;
  marketplaceQuery: string;
  marketplaceResults: MarketplaceSearchResult[];
  marketplaceInstalled: MarketplaceInstalledSkill[];
  marketplaceUpdates: MarketplaceUpdateCheck[];
  marketplaceError: string | null;
  marketplaceBusySlug: string | null;
  marketplaceMessages: MarketplaceMessageMap;
  marketplaceTab: "browse" | "installed";
};

function getErrorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  return String(err);
}

function setMarketplaceMessage(
  state: MarketplaceState,
  slug: string,
  message?: MarketplaceMessage,
) {
  if (!slug.trim()) return;
  const next = { ...state.marketplaceMessages };
  if (message) next[slug] = message;
  else delete next[slug];
  state.marketplaceMessages = next;
}

export async function loadMarketplaceInstalled(state: MarketplaceState) {
  if (!state.client || !state.connected) return;
  if (state.marketplaceLoading) return;

  state.marketplaceLoading = true;
  state.marketplaceError = null;

  try {
    const res = (await state.client.request("clawdhub.installed", {})) as {
      skills: MarketplaceInstalledSkill[];
    } | undefined;
    if (res) {
      state.marketplaceInstalled = res.skills;
    }
  } catch (err) {
    state.marketplaceError = getErrorMessage(err);
  } finally {
    state.marketplaceLoading = false;
  }
}

export async function searchMarketplace(state: MarketplaceState, query: string) {
  if (!state.client || !state.connected) return;
  if (state.marketplaceSearching) return;

  state.marketplaceSearching = true;
  state.marketplaceQuery = query;
  state.marketplaceError = null;

  try {
    const res = (await state.client.request("clawdhub.search", { query })) as {
      results: MarketplaceSearchResult[];
      total: number;
    } | undefined;
    if (res) {
      state.marketplaceResults = res.results;
    }
  } catch (err) {
    state.marketplaceError = getErrorMessage(err);
    state.marketplaceResults = [];
  } finally {
    state.marketplaceSearching = false;
  }
}

export async function installMarketplaceSkill(
  state: MarketplaceState,
  slug: string,
  version?: string,
) {
  if (!state.client || !state.connected) return;

  state.marketplaceBusySlug = slug;
  state.marketplaceError = null;

  try {
    const params: { slug: string; version?: string } = { slug };
    if (version) params.version = version;

    const res = (await state.client.request("clawdhub.install", params)) as {
      ok: boolean;
      slug: string;
      version: string;
      path: string;
      message?: string;
    } | undefined;

    if (res?.ok) {
      setMarketplaceMessage(state, slug, {
        kind: "success",
        message: res.message || `Installed ${slug}@${res.version}`,
      });
      // Refresh installed list
      await loadMarketplaceInstalled(state);
    } else {
      setMarketplaceMessage(state, slug, {
        kind: "error",
        message: res?.message || "Installation failed",
      });
    }
  } catch (err) {
    const message = getErrorMessage(err);
    state.marketplaceError = message;
    setMarketplaceMessage(state, slug, { kind: "error", message });
  } finally {
    state.marketplaceBusySlug = null;
  }
}

export async function checkMarketplaceUpdates(state: MarketplaceState) {
  if (!state.client || !state.connected) return;
  if (state.marketplaceLoading) return;

  state.marketplaceLoading = true;
  state.marketplaceError = null;

  try {
    const res = (await state.client.request("clawdhub.checkUpdates", {})) as {
      updates: MarketplaceUpdateCheck[];
    } | undefined;
    if (res) {
      state.marketplaceUpdates = res.updates;
    }
  } catch (err) {
    state.marketplaceError = getErrorMessage(err);
  } finally {
    state.marketplaceLoading = false;
  }
}

export function clearMarketplaceMessage(state: MarketplaceState, slug: string) {
  setMarketplaceMessage(state, slug, undefined);
}

export function setMarketplaceTab(state: MarketplaceState, tab: "browse" | "installed") {
  state.marketplaceTab = tab;
}
