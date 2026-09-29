/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import type { SidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import { createStore, cronPage } from "./sidebar-attention-store.test-support.ts";
import { SidebarAttentionStoreController } from "./sidebar-attention-store.ts";

let store: SidebarAttentionStore | undefined;
afterEach(() => {
  store?.dispose();
  store = undefined;
});

it("keeps active permission warnings independent of update dismissal and retires only published blockers", () => {
  const request = vi.fn(async (method: string) =>
    method === "cron.list"
      ? cronPage()
      : method === "cron.status"
        ? { enabled: false, jobs: 0 }
        : { ts: 1, providers: [] },
  );
  const harness = createGatewayHarness(mockClient(request));
  const hook = {
    pluginId: "notes",
    pluginName: "Notes",
    hookName: "before_prompt_build",
    reason: "conversation-access-missing" as const,
    severity: "warn" as const,
    configPath: "plugins.entries.notes.hooks.allowConversationAccess",
    message: "Host refusal",
  };
  harness.update({
    pluginCapabilities: { ok: true, descriptors: [], generation: 1, blockedHooks: [hook] },
  });
  store = createStore(harness.gateway);
  store.activate(SidebarAttentionStoreController);
  const warnings = () =>
    store!.entries.filter(
      (entry) => entry.type === "attention" && entry.kind === "pluginAccessBlocked",
    );
  expect(warnings()).toMatchObject([{ label: "Notes", requiresAction: true, dismissal: null }]);
  store.dismiss({ kind: "updateAvailable", signature: "finished-update" });
  expect(warnings()).toHaveLength(1);
  harness.update({
    pluginCapabilities: {
      ok: true,
      descriptors: [],
      generation: 2,
      blockedHooks: [{ ...hook, reason: "conversation-access-denied" }],
    },
  });
  expect(warnings()).toMatchObject([{ requiresAction: false }]);
  harness.update({
    pluginCapabilities: { ok: true, descriptors: [], generation: 3, blockedHooks: [] },
  });
  expect(warnings()).toEqual([]);
  harness.update({ phase: "reconnecting", pluginCapabilities: null });
  expect(warnings()).toEqual([]);
});
