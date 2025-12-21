import type { Server } from "node:http";

import { createTargetViaCdp } from "./cdp.js";
import {
  isChromeReachable,
  launchClawdChrome,
  type RunningChrome,
  stopClawdChrome,
} from "./chrome.js";
import type { ResolvedBrowserConfig } from "./config.js";
import { resolveTargetIdFromTabs } from "./target-id.js";

export type BrowserTab = {
  targetId: string;
  title: string;
  url: string;
  wsUrl?: string;
  type?: string;
};

export type BrowserServerState = {
  server: Server;
  port: number;
  cdpPort: number;
  running: RunningChrome | null;
  resolved: ResolvedBrowserConfig;
};

export type BrowserRouteContext = {
  state: () => BrowserServerState;
  ensureBrowserAvailable: () => Promise<void>;
  ensureTabAvailable: (targetId?: string) => Promise<BrowserTab>;
  isReachable: (timeoutMs?: number) => Promise<boolean>;
  listTabs: () => Promise<BrowserTab[]>;
  openTab: (url: string) => Promise<BrowserTab>;
  focusTab: (targetId: string) => Promise<void>;
  closeTab: (targetId: string) => Promise<void>;
  stopRunningBrowser: () => Promise<{ stopped: boolean }>;
  mapTabError: (err: unknown) => { status: number; message: string } | null;
};

type ContextOptions = {
  getState: () => BrowserServerState | null;
  setRunning: (running: RunningChrome | null) => void;
};

async function fetchJson<T>(
  url: string,
  timeoutMs = 1500,
  init?: RequestInit,
): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function fetchOk(
  url: string,
  timeoutMs = 1500,
  init?: RequestInit,
): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(t);
  }
}

export function createBrowserRouteContext(
  opts: ContextOptions,
): BrowserRouteContext {
  const state = () => {
    const current = opts.getState();
    if (!current) throw new Error("Browser server not started");
    return current;
  };

  const listTabs = async (): Promise<BrowserTab[]> => {
    const current = state();
    const raw = await fetchJson<
      Array<{
        id?: string;
        title?: string;
        url?: string;
        webSocketDebuggerUrl?: string;
        type?: string;
      }>
    >(`http://127.0.0.1:${current.cdpPort}/json/list`);
    return raw
      .map((t) => ({
        targetId: t.id ?? "",
        title: t.title ?? "",
        url: t.url ?? "",
        wsUrl: t.webSocketDebuggerUrl,
        type: t.type,
      }))
      .filter((t) => Boolean(t.targetId));
  };

  const openTab = async (url: string): Promise<BrowserTab> => {
    const current = state();
    const createdViaCdp = await createTargetViaCdp({
      cdpPort: current.cdpPort,
      url,
    })
      .then((r) => r.targetId)
      .catch(() => null);

    if (createdViaCdp) {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const tabs = await listTabs().catch(() => [] as BrowserTab[]);
        const found = tabs.find((t) => t.targetId === createdViaCdp);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 100));
      }
      return { targetId: createdViaCdp, title: "", url, type: "page" };
    }

    const encoded = encodeURIComponent(url);

    type CdpTarget = {
      id?: string;
      title?: string;
      url?: string;
      webSocketDebuggerUrl?: string;
      type?: string;
    };

    const endpoint = `http://127.0.0.1:${current.cdpPort}/json/new?${encoded}`;
    const created = await fetchJson<CdpTarget>(endpoint, 1500, {
      method: "PUT",
    }).catch(async (err) => {
      if (String(err).includes("HTTP 405")) {
        return await fetchJson<CdpTarget>(endpoint, 1500);
      }
      throw err;
    });

    if (!created.id) throw new Error("Failed to open tab (missing id)");
    return {
      targetId: created.id,
      title: created.title ?? "",
      url: created.url ?? url,
      wsUrl: created.webSocketDebuggerUrl,
      type: created.type,
    };
  };

  const isReachable = async (timeoutMs = 300) => {
    const current = state();
    return await isChromeReachable(current.cdpPort, timeoutMs);
  };

  const ensureBrowserAvailable = async (): Promise<void> => {
    const current = state();
    if (await isReachable()) return;
    if (current.resolved.attachOnly) {
      throw new Error(
        "Browser attachOnly is enabled and no browser is running.",
      );
    }

    const launched = await launchClawdChrome(current.resolved);
    opts.setRunning(launched);
    launched.proc.on("exit", () => {
      const live = opts.getState();
      if (live?.running?.pid === launched.pid) {
        opts.setRunning(null);
      }
    });
  };

  const ensureTabAvailable = async (targetId?: string): Promise<BrowserTab> => {
    await ensureBrowserAvailable();
    const tabs1 = await listTabs();
    if (tabs1.length === 0) {
      await openTab("about:blank");
    }

    const tabs = await listTabs();
    const chosen = targetId
      ? (() => {
          const resolved = resolveTargetIdFromTabs(targetId, tabs);
          if (!resolved.ok) {
            if (resolved.reason === "ambiguous") return "AMBIGUOUS" as const;
            return null;
          }
          return tabs.find((t) => t.targetId === resolved.targetId) ?? null;
        })()
      : (tabs.at(0) ?? null);

    if (chosen === "AMBIGUOUS") {
      throw new Error("ambiguous target id prefix");
    }
    if (!chosen?.wsUrl) throw new Error("tab not found");
    return chosen;
  };

  const focusTab = async (targetId: string): Promise<void> => {
    const current = state();
    const tabs = await listTabs();
    const resolved = resolveTargetIdFromTabs(targetId, tabs);
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        throw new Error("ambiguous target id prefix");
      }
      throw new Error("tab not found");
    }
    await fetchOk(
      `http://127.0.0.1:${current.cdpPort}/json/activate/${resolved.targetId}`,
    );
  };

  const closeTab = async (targetId: string): Promise<void> => {
    const current = state();
    const tabs = await listTabs();
    const resolved = resolveTargetIdFromTabs(targetId, tabs);
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        throw new Error("ambiguous target id prefix");
      }
      throw new Error("tab not found");
    }
    await fetchOk(
      `http://127.0.0.1:${current.cdpPort}/json/close/${resolved.targetId}`,
    );
  };

  const stopRunningBrowser = async (): Promise<{ stopped: boolean }> => {
    const current = state();
    if (!current.running) return { stopped: false };
    await stopClawdChrome(current.running);
    opts.setRunning(null);
    return { stopped: true };
  };

  const mapTabError = (err: unknown) => {
    const msg = String(err);
    if (msg.includes("ambiguous target id prefix")) {
      return { status: 409, message: "ambiguous target id prefix" };
    }
    if (msg.includes("tab not found")) {
      return { status: 404, message: "tab not found" };
    }
    return null;
  };

  return {
    state,
    ensureBrowserAvailable,
    ensureTabAvailable,
    isReachable,
    listTabs,
    openTab,
    focusTab,
    closeTab,
    stopRunningBrowser,
    mapTabError,
  };
}
