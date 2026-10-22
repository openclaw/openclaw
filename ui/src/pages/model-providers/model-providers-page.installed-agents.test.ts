/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { WizardNextResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ConfigPatchAck } from "../../lib/config/config-draft-model.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
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
type Page = ModelProvidersPageTestElement;

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
const inventory = (enabled = true) => ({ agents: [agent("opencode", "OpenCode", { enabled })] });
const catalogModel = (provider = "acp-opencode") => ({ provider, id: "cedar", name: "Cedar" });
type Request = ReturnType<typeof createHarness>["request"];
type RequestParams = { answer?: { value?: unknown }; refresh?: boolean };

function handleRequests(
  request: Request,
  handlers: Record<string, (params?: RequestParams) => unknown>,
) {
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (method, params?: RequestParams) =>
    handlers[method] ? handlers[method](params) : original(method),
  );
}

function createAgentsHarness(listAgents: () => Promise<unknown>) {
  const harness = createHarness("main");
  harness.snapshot.hello!.features!.methods!.push("acpx.agents.list");
  handleRequests(harness.request, {
    "acpx.agents.list": listAgents,
    "models.list": () => ({ models: [catalogModel()] }),
  });
  return harness;
}

function opencodeHarness(enabled: () => boolean = () => true) {
  return createAgentsHarness(async () => inventory(enabled()));
}
const wizard = (page: Page) => page.querySelector(".model-setup-wizard");
const primary = (page: Page) =>
  page.querySelector<HTMLButtonElement>(".model-setup-wizard .btn.primary")!;

function agentRow(page: Page, id: string) {
  return page.querySelector<HTMLElement>(`[data-installed-agent="${id}"]`);
}

async function mountAgents(
  context: ApplicationContext,
  config?: Parameters<typeof waitForProviders>[1],
) {
  const page = appendPage(context);
  await waitForProviders(page, config);
  await waitForSolid(() => expect(agentRow(page, "opencode")).not.toBeNull());
  return page;
}
const toggle = (page: Page, id = "opencode") =>
  agentRow(page, id)!.querySelector<HTMLInputElement>('.settings-toggle__input[role="switch"]')!;
const clickAgent = (page: Page) =>
  agentRow(page, "opencode")!.querySelector<HTMLElement>(".settings-row__title")!.click();
const agentText = (page: Page) => agentRow(page, "opencode")?.textContent;
const refreshButton = (page: Page, scope = "") =>
  page.querySelector<HTMLButtonElement>(`${scope} .model-providers__refresh-button`)!;
const nativeAgents = (enabled: boolean) => ({
  plugins: { entries: { acpx: { config: { nativeAgents: { opencode: enabled } } } } },
});
function consentRequest(
  request: Request,
  answer: (value: unknown) => unknown,
  step: { message?: string; title?: string } = {},
  cancel = false,
) {
  handleRequests(request, {
    "openclaw.setup.runtime.start": () => ({ done: false, status: "running" }),
    "wizard.next": (params) =>
      params?.answer
        ? answer(params.answer.value)
        : {
            done: false,
            status: "running",
            step: { id: "runtime-consent", type: "confirm", message: "Allow runtime?", ...step },
          },
    ...(cancel ? { "wizard.cancel": () => ({ status: "cancelled" }) } : {}),
  });
}

async function openConsent(context: ApplicationContext, message = "Allow runtime?") {
  const page = await mountAgents(context);
  clickAgent(page);
  await waitForSolid(() => expect(wizard(page)?.textContent).toContain(message));
  return page;
}

it("keeps the loaded inventory visible across a same-client reconnect, but not a new client", async () => {
  const refreshing = deferred<ReturnType<typeof inventory>>();
  const replacement = deferred<ReturnType<typeof inventory>>();
  let replace = false;
  let replacementReads = 0;
  const { context, snapshot, gatewaySource, publishPhase, request } = createAgentsHarness(
    async () => {
      if (!replace) {
        return inventory();
      }
      return ++replacementReads === 1 ? refreshing.promise : replacement.promise;
    },
  );
  const page = appendPage(context);
  try {
    await waitForSolid(() => expect(agentRow(page, "opencode")).not.toBeNull());
    const row = agentRow(page, "opencode");
    replace = true;
    publishPhase("offline");
    await page.updateComplete;
    expect(agentRow(page, "opencode")).toBe(row);
    publishPhase("connected");
    await page.updateComplete;
    expect(agentRow(page, "opencode")).toBe(row);
    gatewaySource.publish({ ...snapshot, client: createTestGatewayClient(request) });
    await page.updateComplete;
    expect(agentRow(page, "opencode")).toBeNull();
    replacement.resolve({ agents: [agent("opencode", "New OpenCode")] });
    await waitForSolid(() => expect(agentText(page)).toContain("New OpenCode"));
    expect(agentRow(page, "opencode")).not.toBe(row);
  } finally {
    refreshing.resolve({ agents: [] });
  }
});

it("enables for the selected agent through the shared consent wizard", async () => {
  const restoreDialog = installDialogPolyfill();
  let enabled = false;
  const { context, request, runtimeConfig, settingsAgentSelection } = opencodeHarness(
    () => enabled,
  );
  settingsAgentSelection.state.selectedId = "writer";
  consentRequest(
    request,
    (value) => {
      enabled = value === true;
      return { done: true, status: "done" };
    },
    {
      title: "Installed agent permissions",
      message: "Allow this runtime to execute code?",
    },
  );
  const page = await openConsent(context, "Allow this runtime to execute code?");
  try {
    expect(request).toHaveBeenCalledWith(
      "openclaw.setup.runtime.start",
      {
        sessionId: expect.any(String),
        agentId: "writer",
        runtimeId: "acp-opencode",
        configPatch: nativeAgents(true),
      },
      { timeoutMs: null },
    );
    expect(enabled).toBe(false);
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    primary(page).click();
    await waitForSolid(() => expect(wizard(page)?.textContent).toContain("OpenCode is enabled."));
    expect(request).toHaveBeenCalledWith(
      "wizard.next",
      expect.objectContaining({ answer: { stepId: "runtime-consent", value: true } }),
      expect.anything(),
    );
    expect(enabled).toBe(true);
    expect(runtimeConfig.refresh).toHaveBeenCalled();
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    await waitForSolid(() => expect(agentText(page)).not.toContain("Saving"));
    const close = [...wizard(page)!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Close",
    );
    expect(close).toBeDefined();
    close!.click();
    await waitForSolid(() => expect(wizard(page)).toBeNull());
    expect(toggle(page)).toMatchObject({ checked: true });
  } finally {
    unmountPage(page);
    restoreDialog();
  }
});

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
    } = opencodeHarness(() => false);
    consentRequest(request, () => answer.promise, {}, true);
    const page = await openConsent(context);
    try {
      const staleButton = primary(page);
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
      await waitForSolid(() => expect(wizard(page)).toBeNull());
      await drainPageUpdates(page);
      const refreshes = vi.mocked(runtimeConfig.refresh).mock.calls.length;
      answer.resolve({ done: true, status: "done" });
      await drainPageUpdates(page);
      staleButton.click();
      expect(wizard(page)).toBeNull();
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
  const page = await mountAgents(context);
  await waitForSolid(() => expect(agentRow(page, "pi")).not.toBeNull());
  expect(agentText(page)).not.toContain("Models available");
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
  let recovered = false;
  handleRequests(request, {
    "models.list": (params) => {
      recovered ||= params?.refresh === true;
      return recovered
        ? {
            models: [{ ...catalogModel("acp-qwen"), available: true }],
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
    },
  });
  const page = appendPage(context);
  await waitForProviders(page);
  await waitForSolid(() => {
    expect(agentRow(page, "qwen")?.textContent).toMatch(/sign in required/i);
    expect(agentRow(page, "kilocode")?.textContent).toMatch(/models unavailable/i);
    expect(agentText(page)).toMatch(/discovering models/i);
    expect(agentText(page)).not.toMatch(/sign.in/i);
  });
  expect(toggle(page)).toMatchObject({ disabled: false });
  refreshButton(page, ".model-providers__installed-agents").click();
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
    return reads === 2 ? staleRead.promise : inventory(enabled);
  });
  const page = await mountAgents(context);
  publishEvent({ type: "event", event: "config.changed", payload: {} });
  await waitForSolid(() => {
    expect(reads).toBe(2);
    expect(runtimeConfig.state.configLoading).toBe(false);
  });

  vi.mocked(runtimeConfig.patch).mockImplementation(async () => {
    enabled = false;
    return true;
  });
  clickAgent(page);

  await waitForSolid(() => {
    expect(reads).toBe(3);
    expect(toggle(page)).toMatchObject({ checked: false, disabled: false });
  });
  expect(runtimeConfig.patch).toHaveBeenCalledWith(
    expect.objectContaining({ raw: nativeAgents(false) }),
  );
  staleRead.resolve(inventory());
  await staleRead.promise;
  await page.updateComplete;
  expect(toggle(page).checked).toBe(false);
});

it("disables at the config acknowledgement without erasing remembered consent", async () => {
  const config = (enabled: boolean) => ({
    agents: { entries: { main: { nativeRuntimeConsent: ["acp-opencode"] } } },
    ...nativeAgents(enabled),
  });
  const acknowledgement = deferred<ConfigPatchAck>();
  const configRead = deferred<unknown>();
  const agentRead = deferred<unknown>();
  let holdReads = false;
  const { context, request, deferNextAuthStatus } = createAgentsHarness(async () =>
    holdReads ? agentRead.promise : inventory(),
  );
  handleRequests(request, {
    "config.get": () =>
      holdReads ? configRead.promise : { config: config(true), hash: "before", valid: true },
    "config.patch": () => acknowledgement.promise,
  });
  const runtimeConfig = createRuntimeConfigCapability(context.gateway);
  const page = await mountAgents({ ...context, runtimeConfig }, config(true));
  const releaseAuthStatus = deferNextAuthStatus();
  const releaseReads = () => {
    agentRead.resolve(inventory());
    configRead.resolve({ config: config(false), hash: "saved", valid: true });
    releaseAuthStatus();
  };
  try {
    holdReads = true;
    clickAgent(page);
    await waitForSolid(() => expect(agentText(page)).toContain("Saving"));
    acknowledgement.resolve({ config: config(false), hash: "saved" });

    await waitForSolid(() => {
      expect(agentText(page)).not.toContain("Saving");
      expect(toggle(page).checked).toBe(false);
    });
    expect(currentConfigObject(runtimeConfig.state)).toEqual(config(false));
    expect(requestCount(request, "openclaw.setup.runtime.start")).toBe(0);
    expect(request).toHaveBeenCalledWith(
      "config.patch",
      expect.objectContaining({
        raw: JSON.stringify(nativeAgents(false)),
      }),
    );

    // Installation metadata can still reflect the previous runtime generation.
    releaseReads();
    await waitForSolid(() => expect(refreshButton(page).disabled).toBe(false));
    expect(toggle(page).checked).toBe(false);
  } finally {
    acknowledgement.resolve({ config: config(false), hash: "saved" });
    releaseReads();
    runtimeConfig.dispose();
  }
});

it("reads a concurrent edit after a rejected save and keeps the error visible", async () => {
  let enabled = true;
  const { context, runtimeConfig, publishEvent } = opencodeHarness(() => enabled);
  const page = await mountAgents(context);
  vi.mocked(runtimeConfig.patch).mockImplementation(async () => {
    enabled = false;
    publishEvent({ type: "event", event: "config.changed", payload: {} });
    runtimeConfig.state.lastError = "Config changed on disk.";
    return false;
  });

  clickAgent(page);

  await waitForSolid(() =>
    expect(agentRow(page, "opencode")?.querySelector('[role="alert"]')?.textContent).toContain(
      "Config changed on disk.",
    ),
  );
  const switchInput = toggle(page);
  await waitForSolid(() => expect(switchInput.checked).toBe(false));
});

it("does not publish a disable failure into another selected agent", async () => {
  const patch = deferred<boolean>();
  const { context, runtimeConfig, settingsAgentSelection, notifySelection } = opencodeHarness();
  const page = await mountAgents(context);
  vi.mocked(runtimeConfig.patch).mockReturnValueOnce(patch.promise);
  clickAgent(page);
  await waitForSolid(() => expect(runtimeConfig.patch).toHaveBeenCalledOnce());
  settingsAgentSelection.state.selectedId = "writer";
  settingsAgentSelection.intentRevision += 1;
  notifySelection();
  runtimeConfig.state.lastError = "Original agent save failed.";
  patch.resolve(false);
  await drainPageUpdates(page);
  expect(page.renderRoot.textContent).not.toContain("Original agent save failed.");
  expect(agentText(page)).not.toContain("Saving");
});

it("keeps the list readable but locked without admin access", async () => {
  const { context, snapshot, gatewaySource, runtimeConfig } = opencodeHarness();
  snapshot.hello!.auth = { role: "operator", scopes: ["operator.read"] };
  gatewaySource.publish({ ...snapshot });
  const page = await mountAgents(context);

  clickAgent(page);

  expect(toggle(page)).toMatchObject({ disabled: true });
  expect(page.querySelector(".model-providers__installed-agents")?.textContent).toContain(
    "Model changes require operator.admin access.",
  );
  expect(runtimeConfig.patch).not.toHaveBeenCalled();
});

it("releases the initial provider gate after inventory failure and recovers on retry", async () => {
  const initial = deferred<unknown>();
  let reads = 0;
  const { context, request } = createAgentsHarness(async () =>
    ++reads === 1 ? initial.promise : inventory(),
  );
  const page = appendPage(context);
  await waitForSolid(() => expect(requestCount(request, "acpx.agents.list")).toBe(1));
  expect(agentRow(page, "opencode")).toBeNull();
  expect(page.querySelector(".model-providers__search")).toBeNull();
  initial.reject(new Error("Inventory unavailable"));
  await waitForProviders(page);
  await waitForSolid(() => expect(page.querySelector(".model-providers__search")).not.toBeNull());
  const section = page.querySelector(".model-providers__installed-agents")!;
  await waitForSolid(() =>
    expect(section.querySelector('[role="alert"]')?.textContent).toBe("Inventory unavailable"),
  );
  [...section.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Retry")!
    .click();
  await waitForSolid(() => expect(agentRow(page, "opencode")).not.toBeNull());
  expect(section.querySelector('[role="alert"]')).toBeNull();
});

it("retains inventory and its refresh control through a failed refresh and retry", async () => {
  const refreshing = deferred<unknown>();
  let reads = 0;
  const retry = deferred<unknown>();
  const { context } = createAgentsHarness(async () => {
    reads += 1;
    return reads === 2 ? refreshing.promise : reads === 3 ? retry.promise : inventory();
  });
  const page = await mountAgents(context);
  const section = page.querySelector(".model-providers__installed-agents")!;
  const row = agentRow(page, "opencode");
  const refresh = refreshButton(page, ".model-providers__installed-agents");
  expect(refresh.getAttribute("aria-label")).toBe("Check again");
  refresh.focus();
  refresh.click();
  await waitForSolid(() => expect(refresh.disabled).toBe(true));
  expect(refresh.getAttribute("aria-label")).toBe("Checking…");
  expect(agentRow(page, "opencode")).toBe(row);
  refreshing.reject(new Error("Inventory refresh failed"));
  await waitForSolid(() =>
    expect(section.querySelector('[role="alert"]')?.textContent).toBe("Inventory refresh failed"),
  );
  expect(refreshButton(page, ".model-providers__installed-agents")).toBe(refresh);
  expect(refresh.getAttribute("aria-label")).toBe("Check again");
  expect(agentRow(page, "opencode")).toBe(row);
  [...section.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === "Retry")!
    .click();
  await waitForSolid(() => expect(refresh.disabled).toBe(true));
  expect(refresh.getAttribute("aria-label")).toBe("Checking…");
  expect(section.querySelector('[role="alert"]')).toBeNull();
  expect(agentRow(page, "opencode")).toBe(row);
  retry.resolve({ agents: [agent("opencode", "OpenCode refreshed")] });
  await waitForSolid(() => expect(refresh.disabled).toBe(false));
  expect(refresh.getAttribute("aria-label")).toBe("Check again");
  expect(section.querySelector('[role="alert"]')).toBeNull();
  expect(agentRow(page, "opencode")).toBe(row);
  expect(agentText(page)).toContain("OpenCode refreshed");
});
