/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import {
  addDismissal,
  dismissalStoreKey,
  pruneDismissals,
  type SidebarAttentionKind,
} from "./sidebar-attention-dismissals.ts";
import { buildSidebarAttentionItems } from "./sidebar-attention.ts";

const NOW = 1_750_000_000_000;

function cronJob(overrides: Partial<CronJob>): CronJob {
  return { id: "job", enabled: true, ...overrides } as CronJob;
}

function authStatus(providers: ReadonlyArray<Record<string, unknown>>): ModelAuthStatusResult {
  return { ts: NOW, providers } as unknown as ModelAuthStatusResult;
}

describe("buildSidebarAttentionItems", () => {
  it("returns nothing when everything is healthy", () => {
    const items = buildSidebarAttentionItems({
      cronJobs: [cronJob({ state: { lastRunStatus: "ok" } as CronJob["state"] })],
      modelAuthStatus: authStatus([
        {
          provider: "openai",
          displayName: "Codex",
          status: "ok",
          profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
        },
      ]),
      now: NOW,
    });
    expect(items).toEqual([]);
  });

  it("flags enabled failing cron jobs but not disabled ones", () => {
    const items = buildSidebarAttentionItems({
      cronJobs: [
        cronJob({ id: "beta", state: { lastRunStatus: "error" } as CronJob["state"] }),
        cronJob({ id: "alpha", state: { lastRunStatus: "error" } as CronJob["state"] }),
        cronJob({
          id: "off",
          enabled: false,
          state: { lastRunStatus: "error" } as CronJob["state"],
        }),
      ],
      modelAuthStatus: null,
      now: NOW,
    });
    expect(items).toEqual([
      {
        kind: "cronFailed",
        severity: "error",
        icon: "clock",
        label: "2 cron job(s) failed",
        routeId: "cron",
        signature: "alpha\nbeta",
      },
    ]);
  });

  it("flags overdue jobs only past the grace window", () => {
    const items = buildSidebarAttentionItems({
      cronJobs: [
        cronJob({ id: "late", state: { nextRunAtMs: NOW - 400_000 } as CronJob["state"] }),
        cronJob({ id: "soon", state: { nextRunAtMs: NOW - 100_000 } as CronJob["state"] }),
        cronJob({
          id: "off",
          enabled: false,
          state: { nextRunAtMs: NOW - 400_000 } as CronJob["state"],
        }),
      ],
      modelAuthStatus: null,
      now: NOW,
    });
    expect(items).toEqual([
      {
        kind: "cronOverdue",
        severity: "warning",
        icon: "clock",
        label: "1 cron job(s) overdue",
        routeId: "cron",
        signature: `late@${NOW - 400_000}`,
      },
    ]);
  });

  it("splits monitored providers into expired and expiring chips", () => {
    const items = buildSidebarAttentionItems({
      cronJobs: [],
      modelAuthStatus: authStatus([
        {
          provider: "openai",
          displayName: "Codex",
          status: "expired",
          profiles: [{ profileId: "codex", type: "oauth", status: "expired" }],
        },
        {
          provider: "anthropic",
          displayName: "Claude",
          status: "expiring",
          profiles: [{ profileId: "claude", type: "oauth", status: "ok" }],
          expiry: { at: NOW + 6 * 86_400_000, label: "6d" },
        },
        {
          // API-key-only providers are not monitored and must stay silent.
          provider: "static",
          displayName: "Static",
          status: "expired",
          profiles: [{ profileId: "static", type: "api-key", status: "ok" }],
        },
      ]),
      now: NOW,
    });
    expect(items).toEqual([
      {
        kind: "modelAuthExpired",
        severity: "error",
        icon: "plug",
        label: "Model auth expired: Codex",
        routeId: "model-providers",
        signature: "openai",
      },
      {
        kind: "modelAuthExpiring",
        severity: "warning",
        icon: "plug",
        label: "Model auth expiring: Claude (6d)",
        routeId: "model-providers",
        signature: "anthropic",
      },
    ]);
  });
});

describe("pruneDismissals", () => {
  const chip = (kind: SidebarAttentionKind, signature: string) => ({ kind, signature });

  it("keeps a dismissal while the same entity set is still affected", () => {
    const dismissals = { cronFailed: "alpha\nbeta" };
    expect(pruneDismissals(dismissals, [chip("cronFailed", "alpha\nbeta")])).toBe(dismissals);
  });

  it("drops a dismissal when the affected set changes so the chip resurfaces", () => {
    expect(
      pruneDismissals({ cronFailed: "alpha", modelAuthExpired: "openai" }, [
        chip("cronFailed", "alpha\nbeta"),
        chip("modelAuthExpired", "openai"),
      ]),
    ).toEqual({ modelAuthExpired: "openai" });
  });

  it("drops a dismissal once the underlying state clears", () => {
    expect(pruneDismissals({ cronFailed: "alpha" }, [])).toEqual({});
  });
});

describe("addDismissal", () => {
  function createStorageMock(): Storage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => [...map.keys()][index] ?? null,
      removeItem: (key: string) => void map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, value),
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges with the persisted map so another tab's dismissal survives", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const key = dismissalStoreKey("ws://gateway.test");
    // Another tab dismissed a cron chip after this tab last loaded.
    localStorage.setItem(key, JSON.stringify({ cronFailed: "alpha" }));

    const next = addDismissal("ws://gateway.test", "modelAuthExpired", "openai");

    const expected = { cronFailed: "alpha", modelAuthExpired: "openai" };
    expect(next).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(expected);
  });
});
