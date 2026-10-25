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
import { expectAbsent, expectContent, expectPresent } from "../../test-helpers/model-providers.ts";
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
const section = (page: Page) => page.querySelector(".model-providers__installed-agents")!;
const alert = (root: ParentNode) => root.querySelector('[role="alert"]');
const clickButton = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")]
    .find((button) => button.textContent?.trim() === label)!
    .click();
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
  await waitForSolid(() => expectContent(wizard(page), [message]));
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
    await waitForSolid(() =>
      expect(page.querySelector<HTMLDialogElement>("dialog.oc-modal-dialog")?.open).toBe(true),
    );
    expect(toggle(page)).toMatchObject({ checked: true, disabled: true });
    expect(agentText(page)).toContain("Saving");
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
    primary(page).click();
    await waitForSolid(() => expectContent(wizard(page), ["OpenCode is enabled."]));
    expect(enabled).toBe(true);
    expect(runtimeConfig.refresh).toHaveBeenCalled();
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    await waitForSolid(() => expect(agentText(page)).not.toContain("Saving"));
    clickButton(wizard(page)!, "Close");
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
      expectContent(page.renderRoot, [], ["OpenCode is enabled."]);
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
  expectAbsent(hiddenPage, ".model-providers__installed-agents");
  expect(requestCount(hidden.request, "acpx.agents.list")).toBe(0);
  unmountPage(hiddenPage);

  const { context } = createAgentsHarness(async () => ({
    agents: [
      agent("opencode", "OpenCode"),
      agent("qwen", "Qwen Code", { installation: "missing", enabled: false }),
      agent("pi", "Pi", { installation: "unverified" }),
      agent("kilo", "Kilo"),
    ],
  }));
  const page = await mountAgents(context);
  await waitForSolid(() => expect(agentRow(page, "pi")).not.toBeNull());
  expect(agentText(page)).not.toContain("Models available");
  expect(agentRow(page, "qwen")).toBeNull();
  expectContent(page.querySelector("[data-installed-agents-missing]"), [
    "Not detected on the Gateway computer: Qwen Code.",
  ]);
  expectContent(agentRow(page, "pi"), ["Not verified"]);
  expectContent(agentRow(page, "kilo"), ["Use Kilo"]);
  expectAbsent(page, ".model-providers__provider-list");
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
  expect(toggle(page).hasAttribute("aria-disabled")).toBe(false);
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
    expect(toggle(page)).toMatchObject({ checked: false });
    expect(toggle(page).hasAttribute("aria-disabled")).toBe(false);
  });
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
    await waitForSolid(() => {
      expect(agentText(page)).toContain("Saving");
      expect(toggle(page)).toMatchObject({ checked: false, disabled: false });
      expect(toggle(page).hasAttribute("aria-disabled")).toBe(true);
    });
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

    releaseReads();
    await waitForSolid(() => expect(refreshButton(page).disabled).toBe(false));
    expect(toggle(page).checked).toBe(false);
  } finally {
    acknowledgement.resolve({ config: config(false), hash: "saved" });
    releaseReads();
    runtimeConfig.dispose();
  }
});

it.each([true, false])(
  "reconciles rejected save with enabled=%s and keeps the error visible",
  async (enabledAfter) => {
    let enabled = true;
    const patch = deferred<boolean>();
    const { context, runtimeConfig, publishEvent } = opencodeHarness(() => enabled);
    const page = await mountAgents(context);
    vi.mocked(runtimeConfig.patch).mockImplementation(async () => {
      const accepted = await patch.promise;
      enabled = enabledAfter;
      publishEvent({ type: "event", event: "config.changed", payload: {} });
      runtimeConfig.state.lastError = "Config changed on disk.";
      return accepted;
    });

    const row = agentRow(page, "opencode");
    clickAgent(page);
    await waitForSolid(() => {
      expect(toggle(page).checked).toBe(false);
      expect(toggle(page).hasAttribute("aria-disabled")).toBe(true);
    });
    patch.resolve(false);

    await waitForSolid(() => expectContent(alert(row!), ["Config changed on disk."]));
    const switchInput = toggle(page);
    await waitForSolid(() => expect(switchInput.checked).toBe(enabledAfter));
  },
);

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
  await waitForSolid(() => {
    expect(agentText(page)).not.toContain("Saving");
    expect(toggle(page).checked).toBe(true);
  });
  runtimeConfig.state.lastError = "Original agent save failed.";
  patch.resolve(false);
  await drainPageUpdates(page);
  expectContent(page.renderRoot, [], ["Original agent save failed."]);
  expect(agentText(page)).not.toContain("Saving");
});

it("keeps the list readable but locked without admin access", async () => {
  const { context, snapshot, gatewaySource, runtimeConfig } = opencodeHarness();
  snapshot.hello!.auth = { role: "operator", scopes: ["operator.read"] };
  gatewaySource.publish({ ...snapshot });
  const page = await mountAgents(context);

  clickAgent(page);

  expect(toggle(page).disabled).toBe(true);
  expectContent(section(page), ["Model changes require operator.admin access."]);
  expect(runtimeConfig.patch).not.toHaveBeenCalled();
});

it("recovers initial inventory failure, then retains inventory through refresh failure and retry", async () => {
  const initial = deferred<unknown>();
  const refreshing = deferred<unknown>();
  const retry = deferred<unknown>();
  const results = [initial.promise, inventory(), refreshing.promise, retry.promise];
  const { context, request } = createAgentsHarness(async () => results.shift() ?? inventory());
  const page = appendPage(context);
  await waitForSolid(() => expect(requestCount(request, "acpx.agents.list")).toBe(1));
  expect(agentRow(page, "opencode")).toBeNull();
  expectAbsent(page, ".model-providers__search");
  initial.reject(new Error("Inventory unavailable"));
  await waitForProviders(page);
  await waitForSolid(() => expectPresent(page, ".model-providers__search"));
  const content = section(page);
  await waitForSolid(() => expect(alert(content)?.textContent).toBe("Inventory unavailable"));
  clickButton(content, "Retry");
  await waitForSolid(() => expect(agentRow(page, "opencode")).not.toBeNull());
  expect(alert(content)).toBeNull();
  const refresh = refreshButton(page, ".model-providers__installed-agents");
  expect(refresh.getAttribute("aria-label")).toBe("Check again");
  refresh.click();
  await waitForSolid(() => expect(refresh.disabled).toBe(true));
  expect(refresh.getAttribute("aria-label")).toBe("Checking…");
  expect(agentText(page)).toContain("OpenCode");
  refreshing.reject(new Error("Inventory refresh failed"));
  await waitForSolid(() => expect(alert(content)?.textContent).toBe("Inventory refresh failed"));
  expect(refreshButton(page, ".model-providers__installed-agents")).toBe(refresh);
  expect(refresh.getAttribute("aria-label")).toBe("Check again");
  expect(agentText(page)).toContain("OpenCode");
  clickButton(content, "Retry");
  await waitForSolid(() => expect(refresh.disabled).toBe(true));
  expect(refresh.getAttribute("aria-label")).toBe("Checking…");
  expect(alert(content)).toBeNull();
  expect(agentText(page)).toContain("OpenCode");
  retry.resolve({ agents: [agent("opencode", "OpenCode refreshed")] });
  await waitForSolid(() => expect(refresh.disabled).toBe(false));
  expect(refresh.getAttribute("aria-label")).toBe("Check again");
  expect(alert(content)).toBeNull();
  expect(agentText(page)).toContain("OpenCode refreshed");
});
