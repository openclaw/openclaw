/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ConfigPatchAck } from "../../lib/config/config-gateway-operations.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  appendPage,
  createHarness,
  requestCount,
  waitForProviders,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const agent = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name,
  runtimeId: `acp-${id}`,
  installation: "installed",
  enabled: true,
  ...overrides,
});

function createAgentsHarness(listAgents: () => Promise<unknown>) {
  const harness = createHarness("main");
  harness.snapshot.hello!.features!.methods!.push("acpx.agents.list");
  const originalRequest = harness.request.getMockImplementation()!;
  harness.request.mockImplementation(async (method: string) => {
    if (method === "acpx.agents.list") {
      return listAgents();
    }
    if (method === "models.list") {
      return { models: [{ provider: "acp-opencode", id: "cedar", name: "Cedar" }] };
    }
    return originalRequest(method);
  });
  return harness;
}

function agentRow(page: HTMLElement, id: string) {
  return page.querySelector<HTMLElement>(`[data-installed-agent="${id}"]`);
}

describe("ModelProvidersPage installed agents", () => {
  it("lists every reported agent with its installation status only when advertised", async () => {
    const hidden = createHarness("main");
    const hiddenPage = appendPage(hidden.context);
    await waitForProviders(hiddenPage);
    expect(hiddenPage.querySelector(".model-providers__installed-agents")).toBeNull();
    expect(requestCount(hidden.request, "acpx.agents.list")).toBe(0);
    hiddenPage.remove();

    const { context, request, settingsAgentSelection, notifySelection } = createAgentsHarness(
      async () => ({
        agents: [
          agent("opencode", "OpenCode"),
          agent("qwen", "Qwen Code", { installation: "missing", enabled: false }),
          agent("pi", "Pi", { installation: "unverified" }),
          agent("kilo", "Kilo"),
        ],
      }),
    );
    const page = appendPage(context);
    await waitForProviders(page);
    await waitForFast(() => expect(agentRow(page, "pi")).not.toBeNull());
    expect(agentRow(page, "opencode")?.textContent).toContain("Installed");
    expect(agentRow(page, "qwen")?.textContent).toContain("Not detected");
    expect(agentRow(page, "pi")?.textContent).toContain("Not verified");
    expect(agentRow(page, "qwen")?.textContent).toContain("Use Qwen Code");
    expect(agentRow(page, "kilo")?.textContent).toContain("Use Kilo");
    expect(page.querySelector(".model-providers__provider-list")).toBeNull();

    settingsAgentSelection.state.selectedId = "writer";
    notifySelection();
    await page.updateComplete;
    expect(agentRow(page, "opencode")).not.toBeNull();
    expect(requestCount(request, "acpx.agents.list")).toBe(1);
  });

  it("saves the enabled flag and keeps it over a list read that started earlier", async () => {
    let enabled = true;
    const staleRead = deferred<unknown>();
    let reads = 0;
    const { context, runtimeConfig, publishEvent } = createAgentsHarness(async () => {
      reads += 1;
      return reads === 2
        ? staleRead.promise
        : { agents: [agent("opencode", "OpenCode", { enabled })] };
    });
    const page = appendPage(context);
    await waitForProviders(page);
    await waitForFast(() => expect(agentRow(page, "opencode")).not.toBeNull());
    publishEvent({ type: "event", event: "config.changed", payload: {} });
    await waitForFast(() => {
      expect(reads).toBe(2);
      expect(runtimeConfig.state.configLoading).toBe(false);
    });

    vi.mocked(runtimeConfig.patch).mockImplementation(async () => {
      enabled = false;
      return true;
    });
    agentRow(page, "opencode")!.querySelector<HTMLElement>(".settings-row__title")!.click();

    const toggle = () =>
      agentRow(page, "opencode")!.querySelector("wa-switch") as HTMLElement & { checked: boolean };
    await waitForFast(() => {
      expect(reads).toBe(3);
      expect(toggle().checked).toBe(false);
      expect(toggle().hasAttribute("disabled")).toBe(false);
    });
    expect(runtimeConfig.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: { plugins: { entries: { acpx: { config: { nativeAgents: { opencode: false } } } } } },
      }),
    );
    staleRead.resolve({ agents: [agent("opencode", "OpenCode", { enabled: true })] });
    await staleRead.promise;
    await page.updateComplete;
    expect(toggle().checked).toBe(false);
  });

  it("finishes saving at the config acknowledgement while readbacks are still pending", async () => {
    const config = (enabled: boolean) => ({
      plugins: { entries: { acpx: { config: { nativeAgents: { opencode: enabled } } } } },
    });
    const acknowledgement = deferred<ConfigPatchAck>();
    const configRead = deferred<unknown>();
    const agentRead = deferred<unknown>();
    let holdReads = false;
    const { context, request, deferNextAuthStatus } = createAgentsHarness(async () =>
      holdReads ? agentRead.promise : { agents: [agent("opencode", "OpenCode")] },
    );
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method) => {
      if (method === "config.get") {
        return holdReads
          ? configRead.promise
          : { config: config(true), hash: "before", valid: true };
      }
      if (method === "config.patch") {
        return acknowledgement.promise;
      }
      return originalRequest(method);
    });
    const runtimeConfig = createRuntimeConfigCapability(context.gateway);
    const page = appendPage({ ...context, runtimeConfig });
    await waitForProviders(page, config(true));
    await waitForFast(() => expect(agentRow(page, "opencode")).not.toBeNull());
    const releaseAuthStatus = deferNextAuthStatus();
    try {
      holdReads = true;
      agentRow(page, "opencode")!.querySelector<HTMLElement>(".settings-row__title")!.click();
      await waitForFast(() => expect(agentRow(page, "opencode")?.textContent).toContain("Saving"));
      acknowledgement.resolve({ config: config(false), hash: "saved" });
      const toggle = () =>
        agentRow(page, "opencode")!.querySelector("wa-switch") as HTMLElement & {
          checked: boolean;
        };
      await waitForFast(() => {
        expect(agentRow(page, "opencode")?.textContent).not.toContain("Saving");
        expect(toggle().checked).toBe(false);
      });

      // Installation metadata can still reflect the previous runtime generation.
      agentRead.resolve({ agents: [agent("opencode", "OpenCode", { enabled: true })] });
      configRead.resolve({ config: config(false), hash: "saved", valid: true });
      releaseAuthStatus();
      await waitForFast(() =>
        expect(
          page.querySelector<HTMLButtonElement>(".model-providers__refresh-button")?.disabled,
        ).toBe(false),
      );
      expect(toggle().checked).toBe(false);
    } finally {
      acknowledgement.resolve({ config: config(false), hash: "saved" });
      configRead.resolve({ config: config(false), hash: "saved", valid: true });
      agentRead.resolve({ agents: [agent("opencode", "OpenCode", { enabled: true })] });
      releaseAuthStatus();
      runtimeConfig.dispose();
    }
  });

  it("reads a concurrent edit after a rejected save and keeps the error visible", async () => {
    let enabled = true;
    const { context, runtimeConfig, publishEvent } = createAgentsHarness(async () => ({
      agents: [agent("opencode", "OpenCode", { enabled })],
    }));
    const page = appendPage(context);
    await waitForProviders(page);
    await waitForFast(() => expect(agentRow(page, "opencode")).not.toBeNull());
    vi.mocked(runtimeConfig.patch).mockImplementation(async () => {
      enabled = false;
      publishEvent({ type: "event", event: "config.changed", payload: {} });
      runtimeConfig.state.lastError = "Config changed on disk.";
      return false;
    });

    agentRow(page, "opencode")!.querySelector<HTMLElement>(".settings-row__title")!.click();

    await waitForFast(() =>
      expect(agentRow(page, "opencode")?.querySelector('[role="alert"]')?.textContent).toContain(
        "Config changed on disk.",
      ),
    );
    const toggle = agentRow(page, "opencode")!.querySelector("wa-switch") as HTMLElement & {
      checked: boolean;
    };
    await waitForFast(() => expect(toggle.checked).toBe(false));
  });

  it("keeps the list readable but locked without admin access", async () => {
    const { context, snapshot, gatewaySource, runtimeConfig } = createAgentsHarness(async () => ({
      agents: [agent("opencode", "OpenCode")],
    }));
    snapshot.hello!.auth = { role: "operator", scopes: ["operator.read"] };
    gatewaySource.publish({ ...snapshot });
    const page = appendPage(context);
    await waitForFast(() => expect(agentRow(page, "opencode")).not.toBeNull());

    agentRow(page, "opencode")!.querySelector<HTMLElement>(".settings-row__title")!.click();

    expect(agentRow(page, "opencode")!.querySelector("wa-switch")?.hasAttribute("disabled")).toBe(
      true,
    );
    expect(page.querySelector(".model-providers__installed-agents")?.textContent).toContain(
      "Model changes require operator.admin access.",
    );
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
  });
});
