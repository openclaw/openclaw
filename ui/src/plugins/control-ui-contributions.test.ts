import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { PluginControlUiDiagnostic } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type { ControlUiAction } from "../../../src/plugin-sdk/control-ui.js";
import { registerListener } from "../../../src/shared/listeners.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import {
  createGatewayHarness,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import { PluginManager } from "./control-ui-manager.solid.tsx";
import type { ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";
import "./control-ui-view.solid.tsx";
import "./control-ui-contributions.solid.tsx";

const sessionKey = "agent:main:main";
const destination = { sessionKey: "agent:writer:resumed", agentId: "writer" };
const button = (element: Element) => element.querySelector<HTMLButtonElement>("button")!;
function expectButton(element: Element, text: string, disabled: boolean) {
  expect([button(element).textContent?.trim(), button(element).disabled]).toEqual([text, disabled]);
}
const completion = (run: ReturnType<typeof vi.fn<ControlUiAction["run"]>>) =>
  Promise.resolve(run.mock.results[0]?.value).then(
    () => undefined,
    (error: unknown) => error,
  );
const invocation = (run: ReturnType<typeof vi.fn<ControlUiAction["run"]>>) =>
  expectDefined(run.mock.calls[0]?.[0], "visible plugin action");
const globalSession = (): GatewaySessionRow => ({
  key: "global",
  kind: "global",
  agentId: "main",
  updatedAt: 1,
  label: "Main",
});

it("renders customization inline and retains pending reload state", async () => {
  const listeners = new Set<() => void>();
  const replacement = {
    key: "fixture/composer",
    pluginId: "fixture",
    value: { surface: "composer", label: "Fixture composer" },
  };
  let selected: typeof replacement | undefined;
  const pendingReload = createDeferred();
  const diagnostics: PluginControlUiDiagnostic[] = [
    {
      pluginId: "custom-review",
      message: "Disabled by Labs",
      code: "custom-plugin-ui-disabled",
    },
  ];
  const plugins = {
    hasPlugins: true,
    errors: diagnostics,
    canReload: true,
    registrations: () => [replacement],
    selectedReplacement: (surface: string) => (surface === "composer" ? selected : undefined),
    selectReplacement: vi.fn((_surface: string, key: string | null) => {
      selected = key ? replacement : undefined;
      listeners.forEach((listener) => listener());
    }),
    reload: vi.fn(() => pendingReload.promise),
    refresh: vi.fn(async () => undefined),
    subscribe: (listener: () => void) => registerListener(listeners, listener),
  };
  const navigate = vi.fn();
  // SAFETY: this fixture supplies the application services consumed by the manager.
  const provider = createSolidApplicationContextProvider({
    plugins,
    basePath: "/console",
    navigate,
  } as unknown as ApplicationContext);
  const { container: manager, getByRole } = mountSolid(PluginManager, {
    wrapper: provider.wrapper,
  });
  const alert = () => manager.querySelector('[role="alert"]');
  const notice = () => manager.querySelector('[role="status"]');
  const managerButton = (label: string) => getByRole("button", { name: label });
  try {
    expect(manager.querySelector("openclaw-modal-dialog")).toBeNull();
    await vi.waitFor(() => expect(manager.querySelector("select")).not.toBeNull());
    expect(alert()).toBeNull();
    expect(notice()?.textContent).toContain("custom-review");
    const labs = manager.querySelector<HTMLAnchorElement>('a[href="/console/settings/labs"]');
    expect(labs?.textContent?.trim()).toBe("Open Labs");
    labs?.click();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("labs");
    await vi.waitFor(() => expect(manager.querySelector("select")).not.toBeNull());

    const select = expectDefined(manager.querySelector<HTMLSelectElement>("select"), "selector");
    for (const key of [replacement.key, null]) {
      plugins.selectReplacement("composer", key);
      await vi.waitFor(() => expect(select.value).toBe(key ?? ""));
    }

    plugins.errors = [];
    listeners.forEach((listener) => listener());
    await vi.waitFor(() => expect(notice()).toBeNull());
    plugins.errors = [{ pluginId: "custom-review", message: "Synthetic activation failure" }];
    listeners.forEach((listener) => listener());
    await vi.waitFor(() => expect(alert()?.textContent).toContain("Synthetic activation failure"));
    plugins.errors = [];
    listeners.forEach((listener) => listener());
    await vi.waitFor(() => expect(alert()).toBeNull());

    for (const key of [replacement.key, ""]) {
      select.value = key;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      expect(plugins.selectReplacement).toHaveBeenLastCalledWith("composer", key || null);
    }

    managerButton(t("pluginUi.reload")).click();
    expect(plugins.reload).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(managerButton(t("pluginUi.reload"))).toHaveProperty("disabled", true),
    );
    managerButton(t("pluginUi.reload")).click();
    expect(plugins.reload).toHaveBeenCalledOnce();
    pendingReload.reject(new Error("Synthetic reload failure"));
    await vi.waitFor(() => expect(alert()?.textContent).toContain("Synthetic reload failure"));
    expect(managerButton(t("pluginUi.reload"))).toHaveProperty("disabled", false);
    managerButton(t("common.retry")).click();
    expect(plugins.refresh).toHaveBeenCalledOnce();
    expect(manager.querySelector("openclaw-modal-dialog")).toBeNull();
  } finally {
    pendingReload.resolve();
  }
});

afterEach(() => document.body.replaceChildren());

async function mountActions(
  options: {
    placement?: "header" | "composer";
    session?: GatewaySessionRow;
    agentId?: string;
  } = {},
) {
  const request = vi.fn().mockResolvedValue({ ok: true });
  const client = { request } as unknown as GatewayBrowserClient;
  const { gateway: gatewayHarness } = createGatewayHarness(client);
  const setSessionKey = vi.fn();
  const gateway = Object.assign(gatewayHarness, { setSessionKey });
  const navigate = vi.fn();
  const agents = createAgentCapability(gateway);
  const agentSelection = createAgentSelectionCapability(
    { ...gateway, connection: { gatewayUrl: "ws://fixture.invalid" } },
    agents,
  );
  const sessions = createSessionCapability(gateway, agentSelection);
  const session: GatewaySessionRow = options.session ?? {
    key: sessionKey,
    kind: "direct",
    updatedAt: 1,
    label: "Ready",
  };
  sessions.reconcile(session, undefined, { resultAgentId: session.agentId });
  const abort = new AbortController();
  const actionAbort = new AbortController();
  const actionSignal = AbortSignal.any([abort.signal, actionAbort.signal]);
  const pluginListeners = new Set<() => void>();
  const run = vi.fn<ControlUiAction["run"]>();
  const resolve = vi.fn<NonNullable<ControlUiAction["resolve"]>>(({ session: currentSession }) => ({
    label: `Review ${currentSession?.label ?? "unavailable"}`,
    hidden: currentSession?.archived === true,
    disabled: currentSession?.hasActiveRun === true,
  }));
  const action: ControlUiAction = {
    id: "review",
    label: "Review session",
    placement: options.placement ?? "header",
    resolve,
    run,
  };
  const plugins = {
    registrations: () => (actionAbort.signal.aborted ? [] : [entry]),
    subscribe: (listener: () => void) => registerListener(pluginListeners, listener),
    reportError: vi.fn(),
    isCurrent: () => !abort.signal.aborted,
  } as unknown as ControlUiPluginRuntime;
  const context = {
    basePath: "",
    gateway,
    agents,
    agentSelection,
    sessions,
    plugins,
    navigate,
  } as unknown as ApplicationContext;
  const owner = {
    abort,
    client,
    descriptor: { pluginId: "fixture" },
    disposers: new Set(),
  } as Omit<ControlUiPluginOwner, "host">;
  const host = createControlUiPluginHost(() => context, plugins, owner);
  const entry = {
    key: "fixture/review",
    pluginId: "fixture",
    value: action,
    host,
    signal: actionSignal,
  };
  const provider = createApplicationContextProvider(context);
  const element = document.createElement("openclaw-plugin-contributions");
  element.kind = options.placement ?? "header";
  element.sessionKey = session.key;
  element.agentId = options.agentId;
  onTestFinished(() => {
    abort.abort();
    agents.dispose();
    sessions.dispose();
  });
  provider.append(element);
  document.body.append(provider);
  await element.updateComplete;
  return {
    element,
    sessions,
    run,
    resolve,
    request,
    navigate,
    setSessionKey,
    patch: async (changes: Partial<GatewaySessionRow>) => {
      sessions.patchRowLocal(session.key, changes);
      await element.updateComplete;
    },
    startPending: () => {
      const release = createDeferred();
      run.mockImplementationOnce(async ({ host: currentHost }) => {
        await release.promise;
        currentHost.sessions.open(destination);
      });
      const retained = button(element);
      retained.click();
      return { release, retained, current: invocation(run), completed: completion(run) };
    },
    unregister: () => {
      actionAbort.abort();
      for (const listener of pluginListeners) {
        listener();
      }
    },
  };
}

it("replaces placement subscriptions and resumes current session presentation", async () => {
  const { element, sessions, patch } = await mountActions();
  expect(element.querySelector("button")?.textContent).toBe("Review Ready");

  element.kind = "composer";
  await element.updateComplete;
  expect(element.querySelector("button")).toBeNull();
  sessions.patchRowLocal(sessionKey, { label: "Updated while hidden" });

  element.kind = "header";
  await element.updateComplete;
  expect(element.querySelector("button")?.textContent).toBe("Review Updated while hidden");
  await patch({ label: "Live again" });
  expect(element.querySelector("button")?.textContent).toBe("Review Live again");
});

it("keeps header metadata scoped to its pane agent when the global key is shared", async () => {
  const { element, sessions, run, resolve, request } = await mountActions({
    placement: "header",
    agentId: "writer",
    session: globalSession(),
  });
  expect(button(element).textContent?.trim()).toBe("Review unavailable");
  button(element).click();
  const target = { sessionKey: "global", agentId: "writer", session: undefined };
  expect(run.mock.calls).toMatchObject([[target]]);
  expect(resolve).toHaveBeenLastCalledWith(target);

  const writer = { ...globalSession(), agentId: "writer", updatedAt: 2, label: "Writer" };
  request.mockResolvedValueOnce(sessionsResult([writer], 2));
  await sessions.refresh({ agentId: "writer", force: true });
  await element.updateComplete;
  expect(button(element).textContent?.trim()).toBe("Review Writer");
  button(element).click();
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]?.[0].session).toMatchObject(writer);
});

it("retires a composer invocation when only its pane agent changes", async () => {
  const { element, run, request } = await mountActions({
    placement: "composer",
    agentId: "main",
    session: globalSession(),
  });
  button(element).click();
  const current = invocation(run);
  expect(current.session).toMatchObject({ key: "global", agentId: "main" });
  await current.host.request("fixture.current-owner");

  element.agentId = "writer";
  expect(current.signal.aborted).toBe(true);
  await expect(current.host.request("fixture.retired-owner")).rejects.toThrow("view has ended");
  expect(request.mock.calls.filter(([method]) => method === "fixture.retired-owner")).toEqual([]);
  await element.updateComplete;
});

it.each(["header", "composer"] as const)(
  "retires hidden %s actions before settlement",
  async (placement) => {
    const { element, sessions, run, navigate, setSessionKey, startPending, patch } =
      await mountActions({ placement });
    expectButton(element, "Review Ready", false);
    const pending = startPending();
    if (placement === "header") {
      // An immediate reshow and retained button cannot revive the old action.
      element.presented = false;
      pending.retained.click();
      element.presented = true;
    } else {
      await patch({ label: "Busy", hasActiveRun: true });
      expectButton(element, "Review Busy", true);
      expect(pending.current.signal.aborted).toBe(false);
      sessions.patchRowLocal(sessionKey, { archived: true });
    }
    expect(pending.current.signal.aborted).toBe(true);
    pending.release.resolve();
    expect(await pending.completed).toMatchObject({ message: "This plugin UI view has ended." });
    expect(navigate).not.toHaveBeenCalled();
    expect(setSessionKey).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    await element.updateComplete;
    if (placement === "header") {
      expect(() => pending.current.host.sessions.open(destination)).toThrow("view has ended");
      expect(element.querySelector('[role="alert"]')).toBeNull();
      run.mockImplementationOnce(({ host }) => host.sessions.open(destination));
      pending.retained.click();
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1]?.[0].signal.aborted).toBe(false);
      expect(setSessionKey).toHaveBeenCalledExactlyOnceWith(destination.sessionKey);
      expect(navigate.mock.calls.map(([route]) => route)).toEqual(["chat"]);
    } else {
      expect(element.querySelector("button")).toBeNull();
      await patch({ label: "Resumed", archived: false, hasActiveRun: false });
      const retained = button(element);
      expectButton(element, "Review Resumed", false);
      element.remove();
      await patch({ label: "Detached", hasActiveRun: true });
      expect([retained.textContent?.trim(), retained.disabled]).toEqual(["Review Resumed", false]);
      retained.click();
      expect(run).toHaveBeenCalledOnce();
    }
    expect(pending.current.signal.aborted).toBe(true);
  },
);

it.each(["before click", "during resolution"])(
  "rejects withdrawal %s before render",
  async (when) => {
    const { element, run, resolve, unregister } = await mountActions();
    const retained = button(element);
    if (when === "before click") {
      unregister();
    } else {
      resolve.mockImplementationOnce(() => {
        unregister();
        return {};
      });
    }
    retained.click();
    expect(run.mock.calls.length).toBe(0);
    await element.updateComplete;
    expect(element.querySelector("button")).toBeNull();
  },
);

it("rechecks eligibility and passes the current session before a pending render", async () => {
  const { element, sessions, run, request, patch } = await mountActions();
  // Click in the same turn as publication, before the old button updates.
  for (const field of ["hasActiveRun", "archived"] as const) {
    sessions.patchRowLocal(sessionKey, { [field]: true });
    button(element).click();
    expect(run).not.toHaveBeenCalled();
    await element.updateComplete;
    await patch({ [field]: false });
  }
  sessions.patchRowLocal(sessionKey, { label: "Latest" });
  button(element).click();
  expect(run.mock.calls.length).toBe(1);
  const current = invocation(run);
  expect(current).toMatchObject({
    sessionKey,
    session: { key: sessionKey, label: "Latest", hasActiveRun: false, archived: false },
  });
  await current.host.request("fixture.current-action");
  expect(request).toHaveBeenCalledWith("fixture.current-action", {});
  await element.updateComplete;

  element.remove();
  const retiredRequest = current.host.request("fixture.retired-action");
  expect(request.mock.calls.filter(([method]) => method === "fixture.retired-action")).toHaveLength(
    0,
  );
  await expect(retiredRequest).rejects.toThrow("view has ended");
  await Promise.resolve();
  expect(current.signal.aborted).toBe(true);
});
