/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { WizardNextResult } from "../../api/types.ts";
import type { ConfigPatchAck } from "../../lib/config/config-draft-model.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  appendPage,
  drainPageUpdates,
  unmountPage,
  createHarness,
  waitForProviders,
  requestCount,
  type ModelProvidersPageTestElement,
} from "./model-providers-page.test-support.tsx";

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

function agentRow(page: ModelProvidersPageTestElement, id: string) {
  return page.querySelector<HTMLElement>(`[data-installed-agent="${id}"]`);
}

describe("ModelProvidersPage installed agents", () => {
  it("enables for the selected agent through the shared consent wizard", async () => {
    const restoreDialog = installDialogPolyfill();
    let enabled = false;
    const { context, request, runtimeConfig, settingsAgentSelection } = createAgentsHarness(
      async () => ({ agents: [agent("opencode", "OpenCode", { enabled })] }),
    );
    settingsAgentSelection.state.selectedId = "writer";
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method, params?: { answer?: { value?: unknown } }) => {
      if (method === "openclaw.setup.runtime.start") {
        return { done: false, status: "running" };
      }
      if (method === "wizard.next") {
        if (params?.answer) {
          enabled = params.answer.value === true;
          return { done: true, status: "done" };
        }
        return {
          done: false,
          status: "running",
          step: {
            id: "runtime-consent",
            type: "confirm",
            title: "Installed agent permissions",
            message: "Allow this runtime to execute code?",
          },
        };
      }
      return originalRequest(method);
    });
    const page = appendPage(context);
    try {
      await waitForProviders(page);
      await waitForSolid(() => expect(agentRow(page, "opencode")).not.toBeNull());
      agentRow(page, "opencode")!.querySelector<HTMLElement>(".settings-row__title")!.click();
      await waitForSolid(() =>
        expect(page.querySelector(".model-setup-wizard")?.textContent).toContain(
          "Allow this runtime to execute code?",
        ),
      );
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.runtime.start",
        {
          sessionId: expect.any(String),
          agentId: "writer",
          runtimeId: "acp-opencode",
          configPatch: {
            plugins: { entries: { acpx: { config: { nativeAgents: { opencode: true } } } } },
          },
        },
        { timeoutMs: null },
      );
      expect(enabled).toBe(false);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      page.querySelector<HTMLButtonElement>(".model-setup-wizard .btn.primary")!.click();
      await waitForSolid(() =>
        expect(page.querySelector(".model-setup-wizard")?.textContent).toContain(
          "OpenCode is enabled.",
        ),
      );
      expect(request).toHaveBeenCalledWith(
        "wizard.next",
        expect.objectContaining({ answer: { stepId: "runtime-consent", value: true } }),
        expect.anything(),
      );
      expect(enabled).toBe(true);
      expect(runtimeConfig.refresh).toHaveBeenCalled();
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      await waitForSolid(() =>
        expect(agentRow(page, "opencode")?.textContent).not.toContain("Saving"),
      );
      const close = [
        ...page.querySelectorAll<HTMLButtonElement>(".model-setup-wizard button"),
      ].find((button) => button.textContent?.trim() === "Close");
      expect(close).toBeDefined();
      close!.click();
      await waitForSolid(() => expect(page.querySelector(".model-setup-wizard")).toBeNull());
      expect(
        agentRow(page, "opencode")?.querySelector<HTMLInputElement>('[role="switch"]')?.checked,
      ).toBe(true);
    } finally {
      unmountPage(page);
      restoreDialog();
    }
  });

  // SAFETY: Literal cases preserve the distinct selection and connection retirement scenarios.
  it.each(["agent", "selection revision", "connection"] as const)(
    "retires an in-flight consent presentation when its %s changes",
    async (change) => {
      const restoreDialog = installDialogPolyfill();
      const answer = deferred<WizardNextResult>();
      const {
        context,
        request,
        runtimeConfig,
        settingsAgentSelection,
        notifySelection,
        publishPhase,
      } = createAgentsHarness(async () => ({
        agents: [agent("opencode", "OpenCode", { enabled: false })],
      }));
      const originalRequest = request.getMockImplementation()!;
      request.mockImplementation(async (method, params?: { answer?: unknown }) => {
        if (method === "openclaw.setup.runtime.start") {
          return { done: false, status: "running" };
        }
        if (method === "wizard.next") {
          return params?.answer
            ? answer.promise
            : {
                done: false,
                status: "running",
                step: { id: "runtime-consent", type: "confirm", message: "Allow runtime?" },
              };
        }
        if (method === "wizard.cancel") {
          return { status: "cancelled" };
        }
        return originalRequest(method);
      });
      const page = appendPage(context);
      try {
        await waitForProviders(page);
        await waitForSolid(() => expect(agentRow(page, "opencode")).not.toBeNull());
        agentRow(page, "opencode")!.querySelector<HTMLElement>(".settings-row__title")!.click();
        await waitForSolid(() =>
          expect(page.querySelector(".model-setup-wizard .btn.primary")).not.toBeNull(),
        );
        const staleButton = page.querySelector<HTMLButtonElement>(
          ".model-setup-wizard .btn.primary",
        )!;
        staleButton.click();
        await waitForSolid(() => expect(staleButton.disabled).toBe(true));
        if (change === "connection") {
          publishPhase("connecting");
        } else {
          if (change === "agent") {
            settingsAgentSelection.state.selectedId = "writer";
          }
          settingsAgentSelection.intentRevision += 1;
          notifySelection();
        }
        await waitForSolid(() => expect(page.querySelector(".model-setup-wizard")).toBeNull());
        await drainPageUpdates(page);
        const refreshes = vi.mocked(runtimeConfig.refresh).mock.calls.length;
        answer.resolve({ done: true, status: "done" });
        await drainPageUpdates(page);
        staleButton.click();
        expect(page.querySelector(".model-setup-wizard")).toBeNull();
        expect(page.renderRoot.textContent).not.toContain("OpenCode is enabled.");
        expect(runtimeConfig.refresh).toHaveBeenCalledTimes(refreshes);
        expect(runtimeConfig.patch).not.toHaveBeenCalled();
        expect(requestCount(request, "openclaw.setup.runtime.start")).toBe(1);
        expect(requestCount(request, "wizard.cancel")).toBe(1);
      } finally {
        answer.resolve({ done: true, status: "cancelled" });
        unmountPage(page);
        restoreDialog();
      }
    },
  );

  it("lists every reported agent with its installation status only when advertised", async () => {
    const hidden = createHarness("main");
    const hiddenPage = appendPage(hidden.context);
    await waitForProviders(hiddenPage);
    expect(hiddenPage.querySelector(".model-providers__installed-agents")).toBeNull();
    expect(requestCount(hidden.request, "acpx.agents.list")).toBe(0);
    unmountPage(hiddenPage);

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
    await waitForSolid(() => expect(agentRow(page, "pi")).not.toBeNull());
    expect(agentRow(page, "opencode")?.textContent).not.toContain("Models available");
    expect(agentRow(page, "qwen")?.textContent).toContain("Not detected");
    expect(agentRow(page, "pi")?.textContent).toContain("Not verified");
    expect(agentRow(page, "qwen")?.textContent).toContain("Use Qwen Code");
    expect(agentRow(page, "kilo")?.textContent).toContain("Use Kilo");
    expect(page.renderRoot.textContent).not.toContain("Saving");
    expect(requestCount(request, "config.patch")).toBe(0);
    expect(page.querySelector(".model-providers__provider-list")).toBeNull();

    settingsAgentSelection.state.selectedId = "writer";
    notifySelection();
    await page.updateComplete;
    expect(agentRow(page, "opencode")).not.toBeNull();
    expect(requestCount(request, "acpx.agents.list")).toBe(1);
  });

  it("distinguishes failed and pending discovery and lets Check again recover models", async () => {
    const { context, request } = createAgentsHarness(async () => ({
      agents: [
        agent("qwen", "Qwen Code"),
        agent("kilocode", "Kilo Code"),
        agent("opencode", "OpenCode"),
      ],
    }));
    const originalRequest = request.getMockImplementation()!;
    let recovered = false;
    request.mockImplementation(async (method: string, params?: { refresh?: boolean }) => {
      if (method === "models.list") {
        recovered ||= params?.refresh === true;
        return recovered
          ? {
              models: [{ provider: "acp-qwen", id: "cedar", name: "Cedar", available: true }],
              providerOutcomes: [{ provider: "acp-qwen", status: "ready" }],
            }
          : {
              models: [],
              pendingProviders: ["acp-opencode"],
              providerOutcomes: [
                { provider: "acp-qwen", status: "auth-rejected" },
                { provider: "acp-kilocode", status: "unavailable" },
              ],
            };
      }
      return originalRequest(method);
    });
    const page = appendPage(context);
    await waitForProviders(page);
    await waitForSolid(() => {
      expect(agentRow(page, "qwen")?.textContent).toMatch(/sign in required/i);
      expect(agentRow(page, "kilocode")?.textContent).toMatch(/models unavailable/i);
      expect(agentRow(page, "opencode")?.textContent).toMatch(/discovering models/i);
      expect(agentRow(page, "opencode")?.textContent).not.toMatch(/sign.in/i);
    });
    expect(
      agentRow(page, "opencode")?.querySelector<HTMLInputElement>(
        '.settings-toggle__input[role="switch"]',
      )?.disabled,
    ).toBe(false);
    page
      .querySelector<HTMLButtonElement>(
        ".model-providers__installed-agents .model-providers__refresh-button",
      )!
      .click();
    await waitForSolid(() => {
      expect(agentRow(page, "qwen")?.textContent).toMatch(/models available/i);
      expect(agentRow(page, "qwen")?.textContent).not.toMatch(/sign in required/i);
    });
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
    await waitForSolid(() => expect(agentRow(page, "opencode")).not.toBeNull());
    publishEvent({ type: "event", event: "config.changed", payload: {} });
    await waitForSolid(() => {
      expect(reads).toBe(2);
      expect(runtimeConfig.state.configLoading).toBe(false);
    });

    vi.mocked(runtimeConfig.patch).mockImplementation(async () => {
      enabled = false;
      return true;
    });
    agentRow(page, "opencode")!.querySelector<HTMLElement>(".settings-row__title")!.click();

    const toggle = () =>
      agentRow(page, "opencode")!.querySelector<HTMLInputElement>(
        '.settings-toggle__input[role="switch"]',
      )!;
    await waitForSolid(() => {
      expect(reads).toBe(3);
      expect(toggle().checked).toBe(false);
      expect(toggle().disabled).toBe(false);
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

  it("disables at the config acknowledgement without erasing remembered consent", async () => {
    const config = (enabled: boolean) => ({
      agents: { entries: { main: { nativeRuntimeConsent: ["acp-opencode"] } } },
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
    await waitForSolid(() => expect(agentRow(page, "opencode")).not.toBeNull());
    const releaseAuthStatus = deferNextAuthStatus();
    try {
      holdReads = true;
      agentRow(page, "opencode")!.querySelector<HTMLElement>(".settings-row__title")!.click();
      await waitForSolid(() => expect(agentRow(page, "opencode")?.textContent).toContain("Saving"));
      acknowledgement.resolve({ config: config(false), hash: "saved" });
      const toggle = () =>
        agentRow(page, "opencode")!.querySelector<HTMLInputElement>(
          '.settings-toggle__input[role="switch"]',
        )!;
      await waitForSolid(() => {
        expect(agentRow(page, "opencode")?.textContent).not.toContain("Saving");
        expect(toggle().checked).toBe(false);
      });
      expect(currentConfigObject(runtimeConfig.state)).toEqual(config(false));
      expect(requestCount(request, "openclaw.setup.runtime.start")).toBe(0);
      expect(request).toHaveBeenCalledWith(
        "config.patch",
        expect.objectContaining({
          raw: JSON.stringify({
            plugins: { entries: { acpx: { config: { nativeAgents: { opencode: false } } } } },
          }),
        }),
      );

      // Installation metadata can still reflect the previous runtime generation.
      agentRead.resolve({ agents: [agent("opencode", "OpenCode", { enabled: true })] });
      configRead.resolve({ config: config(false), hash: "saved", valid: true });
      releaseAuthStatus();
      await waitForSolid(() =>
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
    await waitForSolid(() => expect(agentRow(page, "opencode")).not.toBeNull());
    vi.mocked(runtimeConfig.patch).mockImplementation(async () => {
      enabled = false;
      publishEvent({ type: "event", event: "config.changed", payload: {} });
      runtimeConfig.state.lastError = "Config changed on disk.";
      return false;
    });

    agentRow(page, "opencode")!.querySelector<HTMLElement>(".settings-row__title")!.click();

    await waitForSolid(() =>
      expect(agentRow(page, "opencode")?.querySelector('[role="alert"]')?.textContent).toContain(
        "Config changed on disk.",
      ),
    );
    const toggle = agentRow(page, "opencode")!.querySelector<HTMLInputElement>(
      '.settings-toggle__input[role="switch"]',
    )!;
    await waitForSolid(() => expect(toggle.checked).toBe(false));
  });

  it("does not publish a disable failure into another selected agent", async () => {
    const patch = deferred<boolean>();
    const { context, runtimeConfig, settingsAgentSelection, notifySelection } = createAgentsHarness(
      async () => ({ agents: [agent("opencode", "OpenCode")] }),
    );
    const page = appendPage(context);
    await waitForProviders(page);
    await waitForSolid(() => expect(agentRow(page, "opencode")).not.toBeNull());
    vi.mocked(runtimeConfig.patch).mockReturnValueOnce(patch.promise);
    agentRow(page, "opencode")!.querySelector<HTMLElement>(".settings-row__title")!.click();
    await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.intentRevision += 1;
    notifySelection();
    runtimeConfig.state.lastError = "Original agent save failed.";
    patch.resolve(false);
    await drainPageUpdates(page);
    expect(page.renderRoot.textContent).not.toContain("Original agent save failed.");
    expect(agentRow(page, "opencode")?.textContent).not.toContain("Saving");
  });

  it("keeps the list readable but locked without admin access", async () => {
    const { context, snapshot, gatewaySource, runtimeConfig } = createAgentsHarness(async () => ({
      agents: [agent("opencode", "OpenCode")],
    }));
    snapshot.hello!.auth = { role: "operator", scopes: ["operator.read"] };
    gatewaySource.publish({ ...snapshot });
    const page = appendPage(context);
    await waitForSolid(() => expect(agentRow(page, "opencode")).not.toBeNull());

    agentRow(page, "opencode")!.querySelector<HTMLElement>(".settings-row__title")!.click();

    expect(
      agentRow(page, "opencode")!.querySelector<HTMLInputElement>(
        '.settings-toggle__input[role="switch"]',
      )?.disabled,
    ).toBe(true);
    expect(page.querySelector(".model-providers__installed-agents")?.textContent).toContain(
      "Model changes require operator.admin access.",
    );
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
  });
});
