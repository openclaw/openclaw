import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { runExec } from "../process/exec.js";
import { createTargetViaCdp } from "./cdp.js";
import {
  isChromeCdpReady,
  isChromeReachable,
  launchClawdChrome,
  type RunningChrome,
  resolveClawdUserDataDir,
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
  isHttpReachable: (timeoutMs?: number) => Promise<boolean>;
  isReachable: (timeoutMs?: number) => Promise<boolean>;
  listTabs: () => Promise<BrowserTab[]>;
  openTab: (url: string) => Promise<BrowserTab>;
  focusTab: (targetId: string) => Promise<void>;
  closeTab: (targetId: string) => Promise<void>;
  stopRunningBrowser: () => Promise<{ stopped: boolean }>;
  resetProfile: () => Promise<{
    moved: boolean;
    from: string;
    to?: string;
  }>;
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
    const wsTimeout = Math.max(200, Math.min(2000, timeoutMs * 2));
    return await isChromeCdpReady(current.cdpPort, timeoutMs, wsTimeout);
  };

  const isHttpReachable = async (timeoutMs = 300) => {
    const current = state();
    return await isChromeReachable(current.cdpPort, timeoutMs);
  };

  const attachRunning = (running: RunningChrome) => {
    opts.setRunning(running);
    running.proc.on("exit", () => {
      const live = opts.getState();
      if (live?.running?.pid === running.pid) {
        opts.setRunning(null);
      }
    });
  };

  const ensureBrowserAvailable = async (): Promise<void> => {
    const current = state();
    const httpReachable = await isHttpReachable();
    if (!httpReachable) {
      if (current.resolved.attachOnly) {
        throw new Error(
          "Browser attachOnly is enabled and no browser is running.",
        );
      }
      const launched = await launchClawdChrome(current.resolved);
      attachRunning(launched);
    }

    if (await isReachable()) return;

    if (current.resolved.attachOnly) {
      throw new Error(
        "Browser attachOnly is enabled and CDP websocket is not reachable.",
      );
    }

    if (!current.running) {
      throw new Error(
        "CDP port responds but websocket handshake failed. Ensure the clawd browser owns the port or stop the conflicting process.",
      );
    }

    await stopClawdChrome(current.running);
    opts.setRunning(null);

    const relaunched = await launchClawdChrome(current.resolved);
    attachRunning(relaunched);

    if (!(await isReachable(600))) {
      throw new Error("Chrome CDP websocket is not reachable after restart.");
    }
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

  const resetProfile = async () => {
    const current = state();
    const userDataDir = resolveClawdUserDataDir();

    const httpReachable = await isHttpReachable(300);
    if (httpReachable && !current.running) {
      throw new Error(
        "Browser appears to be running but is not owned by clawd. Stop it before resetting the profile.",
      );
    }

    if (current.running) {
      await stopRunningBrowser();
    }

    try {
      const mod = await import("./pw-ai.js");
      await mod.closePlaywrightBrowserConnection();
    } catch {
      // ignore
    }

    if (!fs.existsSync(userDataDir)) {
      return { moved: false, from: userDataDir };
    }

    const moved = await movePathToTrash(userDataDir);
    return { moved: true, from: userDataDir, to: moved };
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
    isHttpReachable,
    isReachable,
    listTabs,
    openTab,
    focusTab,
    closeTab,
    stopRunningBrowser,
    resetProfile,
    mapTabError,
  };
}

async function movePathToTrash(targetPath: string): Promise<string> {
  try {
    await runExec("trash", [targetPath], { timeoutMs: 10_000 });
    return targetPath;
  } catch {
    const trashDir = path.join(os.homedir(), ".Trash");
    fs.mkdirSync(trashDir, { recursive: true });
    const base = path.basename(targetPath);
    let dest = path.join(trashDir, `${base}-${Date.now()}`);
    if (fs.existsSync(dest)) {
      dest = path.join(trashDir, `${base}-${Date.now()}-${Math.random()}`);
    }
    fs.renameSync(targetPath, dest);
    return dest;
  }
}
