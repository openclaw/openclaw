/* @vitest-environment jsdom */

import { getByRole } from "@solidjs/testing-library";
import { onCleanup } from "solid-js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { configSnapshot } from "../../../lib/config/config-snapshot.test-support.ts";
import { currentConfigObject } from "../../../lib/config/config-state-model.ts";
import { createRuntimeConfigCapability } from "../../../lib/config/runtime-config-capability.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createAgentMemory, type AgentMemoryState } from "./memory-panel-state.ts";
import { AgentMemoryView } from "./memory-panel-view.tsx";
import {
  contextWithRequest,
  createAgentTarget,
  DIARY,
  emptyReply,
  STATUS,
} from "./memory-panel.test-support.ts";
import { installDreamingViewTestTranslations } from "./view.test-helpers.ts";

const restoreTranslations = installDreamingViewTestTranslations();
afterAll(restoreTranslations);
afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

async function memoryPage(config: Record<string, unknown> | null, enabled: boolean | null) {
  let failConfig = config === null;
  const request = vi.fn(async (method: string) => {
    if (method === "config.get") {
      if (failConfig) {
        throw new Error("Synthetic config read failed");
      }
      return configSnapshot(config ?? {});
    }
    if (method === "config.schema") {
      return { schema: {}, uiHints: {}, version: "synthetic" };
    }
    return method === STATUS && enabled !== null ? { dreaming: { enabled } } : emptyReply(method);
  });
  const fixture = contextWithRequest(request);
  const hello = gatewayHelloForMethods([STATUS, DIARY], ["operator.read"]);
  fixture.emit({ hello });
  const runtimeConfig = createRuntimeConfigCapability(fixture.gateway);
  const context = { ...fixture, runtimeConfig };
  const target = createAgentTarget("a07");
  let state: AgentMemoryState;
  const view = mountSolid(() => {
    onCleanup(() => runtimeConfig.dispose());
    state = createAgentMemory(context, () => target);
    return AgentMemoryView({ state });
  });
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledWith("config.get", {});
    expect(request).toHaveBeenCalledWith(STATUS, { agentId: "a07" });
    expect(request).toHaveBeenCalledWith(DIARY, { agentId: "a07" });
    expect(state.view().header.refreshLoading).toBe(false);
  });
  return {
    ...view,
    context,
    runtimeConfig,
    target,
    state: () => state,
    failConfig: () => {
      failConfig = true;
    },
    expectEnabled(expected: boolean) {
      const toggle = getByRole<HTMLInputElement>(view.container, "switch", { name: "Dreaming" });
      expect(toggle.checked).toBe(expected);
      expect(toggle.disabled).toBe(true);
      const scene = view.container.querySelector(".dreams");
      expect(scene).not.toBeNull();
      expect(scene?.classList.contains("dreams--idle")).toBe(!expected);
      expect(view.container.querySelector(".dreams__bubble") !== null).toBe(expected);
    },
  };
}

it.each([
  {
    label: "failed config without runtime enablement",
    config: null,
    enabled: null,
    expected: false,
  },
  { label: "accepted default configuration", config: {}, enabled: null, expected: true },
  {
    label: "explicitly disabled configuration",
    config: {
      plugins: { entries: { "memory-core": { config: { dreaming: { enabled: false } } } } },
    },
    enabled: null,
    expected: false,
  },
  { label: "accepted enabled runtime without config", config: null, enabled: true, expected: true },
  {
    label: "accepted disabled runtime without config",
    config: null,
    enabled: false,
    expected: false,
  },
  { label: "runtime disabled over default config", config: {}, enabled: false, expected: false },
])("presents $label without inventing enablement", async ({ config, enabled, expected }) => {
  const page = await memoryPage(config, enabled);
  if (config === null) {
    expect(page.runtimeConfig.state.lastError).toBe("Synthetic config read failed");
    expect(currentConfigObject(page.runtimeConfig.state)).toBeNull();
  }
  page.expectEnabled(expected);
  page.state().setEnabled(!expected);
  expect(page.state().view().toggle.open).toBe(false);
});

it.each([null, true, false])(
  "retains only accepted scoped enablement through refresh/reconnect (runtime: %s)",
  async (enabled) => {
    const page = await memoryPage({}, enabled);
    page.expectEnabled(enabled ?? true);
    page.failConfig();
    await page.runtimeConfig.refresh();
    expect(page.runtimeConfig.state.lastError).toBe("Synthetic config read failed");
    expect(currentConfigObject(page.runtimeConfig.state)).toEqual({});
    page.expectEnabled(enabled ?? true);
    const hello = page.context.gateway.snapshot.hello;
    page.context.emit({ phase: "reconnecting", hello: null });
    page.context.emit({ phase: "connected", hello });
    await waitForSolid(() => {
      expect(page.runtimeConfig.state.configLoading).toBe(false);
      expect(currentConfigObject(page.runtimeConfig.state)).toBeNull();
      page.expectEnabled(enabled ?? false);
    });
  },
);
