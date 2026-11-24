import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiReplacement,
  ControlUiSurfaceProps,
  ControlUiViewContext,
} from "../../../src/plugin-sdk/control-ui.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { ContentPresentation } from "../lib/solid/presentation.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { flush } from "../test-helpers/solid-settle.ts";
import { PluginSurface } from "./control-ui-view.solid.tsx";
import {
  composerProps,
  createViewRuntime as createRuntime,
  recordReplacement,
  replacement,
} from "./control-ui-view.test-support.ts";
import "./control-ui-contributions.solid.tsx";

const pluginView = (host: HTMLElement) =>
  host.querySelector<HTMLElementTagNameMap["openclaw-plugin-view"]>("openclaw-plugin-view")!;

function mountSurface(
  initial?: ControlUiReplacement<"workspace" | "composer">,
  sessionKey = "main",
) {
  const runtime = createRuntime(initial);
  const provider = createSolidApplicationContextProvider(runtime.context);
  const state = {
    count: 0,
    sessionKey,
    agentId: "main",
    draft: "",
    navigation: document.createElement("nav"),
    setDraft: vi.fn((draft: string): void => {
      state.draft = draft;
    }),
    send: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    abort: vi.fn(),
  };
  const [revision, setRevision] = createSignal(0);
  const [presented, setPresented] = createSignal(true);
  const [contentPresented, setContentPresented] = createSignal(true);
  const identity = () => {
    revision();
    return { sessionKey: state.sessionKey, agentId: state.agentId };
  };
  const renderDefault = () => (
    <>
      <button
        class="builtin-action"
        onClick={() => {
          state.count += 1;
        }}
      >
        Built-in action
      </button>
      <input class="builtin-input" aria-label="Built-in input" />
      {state.navigation}
    </>
  );
  const view = mountSolid(
    () => (
      <ContentPresentation value={contentPresented}>
        {initial?.surface === "composer" ? (
          <PluginSurface
            surface="composer"
            presented={presented()}
            props={composerProps({
              ...identity(),
              draft: state.draft,
              setDraft: state.setDraft,
              send: state.send,
              abort: state.abort,
            })}
            renderDefault={renderDefault}
            renderCompanion={() => (
              <button class="companion-action">Retained attachment controls</button>
            )}
          />
        ) : (
          <PluginSurface
            surface="workspace"
            presented={presented()}
            props={{ ...identity(), routeId: "chat" }}
            renderDefault={renderDefault}
          />
        )}
      </ContentPresentation>
    ),
    { wrapper: provider.wrapper },
  );
  return {
    ...runtime,
    host: view.container,
    state,
    setPresented,
    setContentPresented,
    unmount: view.unmount,
    update: () => setRevision((value) => value + 1),
  };
}

// Unported contribution callers still mount the registered custom element through DOM context.
function mountView(initial: ControlUiReplacement<"workspace" | "composer">) {
  const runtime = createRuntime(initial);
  const provider = createApplicationContextProvider(runtime.context);
  const view = document.createElement("openclaw-plugin-view");
  view.surface = initial.surface;
  view.props = { sessionKey: "main", agentId: "main", routeId: "chat" };
  provider.append(view);
  document.body.append(provider);
  return { ...runtime, view, provider };
}

afterEach(() => document.body.replaceChildren());

describe("native UI built-in delegation", () => {
  it.each(["native", "solid"])(
    "coalesces %s property updates for the mounted plugin",
    async (mode) => {
      const updates: ControlUiViewContext<ControlUiSurfaceProps["workspace"]>[] = [];
      const batched = replacement("workspace", (container) => {
        container.textContent = "Synthetic workspace";
        return { update: (context) => updates.push(context) };
      });
      let view: HTMLElementTagNameMap["openclaw-plugin-view"];
      let refresh: () => void;
      let cleanup: () => void;
      if (mode === "native") {
        const mounted = mountView(batched);
        view = mounted.view;
        refresh = () => {
          view.props = { sessionKey: "main", agentId: "main", routeId: "activity" };
          view.presented = false;
          view.props = { sessionKey: "main", agentId: "main", routeId: "chat" };
          view.presented = true;
        };
        cleanup = () => mounted.provider.remove();
      } else {
        const mounted = mountSurface(batched);
        view = pluginView(mounted.host);
        refresh = () => {
          mounted.update();
          mounted.update();
          mounted.setPresented(false);
          mounted.setPresented(true);
        };
        cleanup = mounted.unmount;
      }
      try {
        await view.updateComplete;
        flush();
        updates.length = 0;
        refresh();
        await view.updateComplete;
        flush();
        await vi.waitFor(() =>
          expect(updates).toMatchObject([{ props: { routeId: "chat" }, presented: true }]),
        );
      } finally {
        cleanup();
      }
    },
  );

  it("gives delegated renderer mounts independent lifetimes and restores fallback after failure", async () => {
    const mounted: HTMLElement[] = [];
    const disposed: HTMLElement[] = [];
    let failUpdate = false;
    const mountDefaultView = (target: HTMLElement) => {
      const button = document.createElement("button");
      button.textContent = "Renderer-owned default";
      target.append(button);
      mounted.push(button);
      return () => {
        disposed.push(button);
        button.remove();
      };
    };
    const { view, select, invalidate } = mountView(
      replacement("workspace", (container, context) => {
        const first = document.createElement("div");
        const second = document.createElement("div");
        container.append(first, second);
        const retireFirstMount = context.mountDefault(first);
        context.mountDefault(first);
        retireFirstMount();
        context.mountDefault(second);
        return {
          update() {
            if (failUpdate) {
              throw new Error("Replacement failed");
            }
          },
        };
      }),
    );
    view.mountDefaultView = mountDefaultView;
    await view.updateComplete;
    expect(mounted).toHaveLength(3);
    expect(view.querySelectorAll("button")).toHaveLength(2);
    expect(disposed).toEqual(mounted.slice(0, 1));
    failUpdate = true;
    invalidate();
    await view.updateComplete;
    await view.updateComplete;
    expect(disposed).toEqual(mounted.slice(0, 3));
    expect(mounted).toHaveLength(4);
    expect(view.textContent).toContain("Renderer-owned default");
    select();
    await view.updateComplete;
    view.remove();
    await Promise.resolve();
    expect(disposed).toEqual(mounted);
  });

  it("recovers the composer after a failed mount publishes an error", async () => {
    const healthy = replacement("composer", (container) => {
      container.textContent = "Healthy composer";
    });
    const { host, state, select, reportError, invalidate, update, unmount } = mountSurface(healthy);
    // Runtime diagnostics publish synchronously from the failing plugin root.
    reportError.mockImplementation(invalidate);
    try {
      await vi.waitFor(() => expect(host.textContent).toContain("Healthy composer"));
      const failure = new Error("Composer failed");
      select(
        replacement("composer", () => {
          throw failure;
        }),
      );
      await vi.waitFor(() => expect(host.querySelector(".builtin-action")).not.toBeNull());
      expect(host.querySelectorAll(".builtin-action")).toHaveLength(1);
      expect(host.querySelector(".companion-action")).toBeNull();
      host.querySelector<HTMLButtonElement>(".builtin-action")!.click();
      expect(state.count).toBe(1);
      expect(reportError).toHaveBeenCalledWith("review", failure);
      expect(host.querySelector("[role=alert]")?.textContent).toContain(failure.message);
      const input = host.querySelector<HTMLInputElement>(".builtin-input")!;
      input.value = "Unsent input";
      input.focus();
      update();
      flush();
      await pluginView(host).updateComplete;
      expect(host.querySelector(".builtin-input")).toBe(input);
      expect(input.value).toBe("Unsent input");
      expect(document.activeElement).toBe(input);
      select(healthy);
      await vi.waitFor(() => expect(host.textContent).toContain("Healthy composer"));
      expect(host.querySelector(".builtin-action")).toBeNull();
      expect(host.querySelector(".companion-action")).not.toBeNull();
      expect(host.querySelector("[role=alert]")).toBeNull();
    } finally {
      unmount();
    }
  });

  it("restores host controls when a replacement stops delegating to the built-in", async () => {
    let stopDefault: (() => void) | undefined;
    const toolbar = document.createElement("button");
    toolbar.textContent = "Plugin action";
    const clicked = vi.fn();
    toolbar.addEventListener("click", clicked);
    const status = document.createElement("output");
    status.textContent = "Plugin status";
    const { host } = mountSurface(
      replacement("composer", (container, context) => {
        container.append(toolbar);
        stopDefault = context.mountDefault(container);
        container.append(status);
        return { dispose: () => stopDefault?.() };
      }),
    );
    await vi.waitFor(() => expect(host.querySelector(".builtin-action")).not.toBeNull());
    expect(host.querySelectorAll(".builtin-action")).toHaveLength(1);
    expect(host.querySelector(".companion-action")).toBeNull();
    expect(toolbar.isConnected).toBe(true);
    expect(status.isConnected).toBe(true);
    stopDefault?.();
    await vi.waitFor(() => expect(host.querySelector(".companion-action")).not.toBeNull());
    expect(host.querySelector(".builtin-action")).toBeNull();
    expect(toolbar.isConnected).toBe(true);
    expect(status.isConnected).toBe(true);
    toolbar.click();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it.each(["surface", "content"])(
    "parks replacement selection with %s presentation and retains the mounted view",
    async (presentation) => {
      const view = mountSurface();
      const setPresented =
        presentation === "surface" ? view.setPresented : view.setContentPresented;
      const builtin = view.host.querySelector(".builtin-action");
      const record = recordReplacement("workspace", "Retained plugin state", true);
      const { contexts, dispose, mount } = record;

      setPresented(false);
      flush();
      expect(view.listeners.size).toBe(0);
      view.select(record.view);
      flush();
      expect(mount).not.toHaveBeenCalled();
      expect(view.host.querySelector(".builtin-action")).toBe(builtin);

      setPresented(true);
      await vi.waitFor(() => expect(mount).toHaveBeenCalledOnce());
      const root = view.host.querySelector("[data-plugin-view-root]");
      setPresented(false);
      await vi.waitFor(() => expect(contexts.at(-1)?.presented).toBe(false));
      expect(view.host.querySelector("[data-plugin-view-root]")).toBe(root);
      expect(root?.textContent).toBe("Retained plugin state");
      expect(dispose).not.toHaveBeenCalled();

      setPresented(true);
      await vi.waitFor(() => expect(contexts.at(-1)?.presented).toBe(true));
      expect(mount).toHaveBeenCalledOnce();
      expect(view.host.querySelector("[data-plugin-view-root]")).toBe(root);
    },
  );

  it.each([
    { label: "another agent", nextAgents: ["writer"] },
    { label: "the original agent after a same-turn switch", nextAgents: ["writer", "main"] },
    { label: "the same replacement after a same-turn deselection" },
    { label: "the same surface after a same-turn selector change", selector: "surface" },
    { label: "the same contribution kind after a same-turn selector change", selector: "kind" },
    {
      label: "the same contribution key after a same-turn selector change",
      selector: "contributionKey",
    },
  ])("retires composer callbacks before rendering $label", async ({ nextAgents, selector }) => {
    const record = recordReplacement("composer", (context) => context.props.agentId);
    const { contexts, roots, dispose } = record;
    const { host, state, request, select } = mountSurface(record.view, "global");
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    const current = contexts[0]!;
    const view = pluginView(host);
    current.props.setDraft("Current draft");
    expect(state.draft).toBe("Current draft");

    if (nextAgents) {
      const props = view.props as ControlUiSurfaceProps["composer"];
      for (const agentId of nextAgents) {
        view.props = { ...props, agentId };
      }
    } else if (selector === "surface") {
      view.surface = "workspace";
      view.surface = "composer";
    } else if (selector === "kind") {
      view.kind = "panels";
      view.kind = "replacements";
    } else if (selector === "contributionKey") {
      view.contributionKey = "review/other";
      view.contributionKey = "";
    } else {
      select();
      select(record.view);
    }
    // Revocation precedes the queued render; DOM disposal belongs to that render.
    expect(dispose).not.toHaveBeenCalled();
    expect(() => current.props.setDraft("Stale draft")).toThrow("view has ended");
    expect(current.signal.aborted).toBe(true);
    expect(state.draft).toBe("Current draft");
    await expect(current.host.request("fixture.retired-view")).rejects.toThrow("view has ended");
    expect(request).not.toHaveBeenCalled();

    await view.updateComplete;
    expect(dispose).toHaveBeenCalledOnce();
    expect(contexts).toHaveLength(2);
    expect(roots[1]).not.toBe(roots[0]);
    const successor = contexts[1]!;
    expect(successor.props.agentId).toBe(nextAgents?.at(-1) ?? "main");
    successor.props.setDraft("Successor draft");
    expect(state.draft).toBe("Successor draft");
  });

  it.each([false, true])(
    "retires hidden composer operations (same-turn return: %s)",
    async (sameTurnReturn) => {
      const record = recordReplacement("composer", "Retained local view state", true);
      const { contexts, roots, dispose } = record;
      const { host, state, request } = mountSurface(record.view);
      await vi.waitFor(() => expect(roots).toHaveLength(1));
      const current = contexts.at(-1)!;
      const view = pluginView(host);
      current.props.setDraft("Current draft");
      const send = createDeferred<boolean>();
      state.send.mockReturnValueOnce(send.promise);
      const pending = expect(current.props.send()).rejects.toThrow("view has ended");
      const setPresented = (value: boolean) => {
        view.presented = value;
      };

      setPresented(false);
      // Presentation retires operations synchronously without retiring the mounted host.
      expect(() => current.props.setDraft("Stale draft")).toThrow("view has ended");
      expect(() => current.props.abort?.()).toThrow("view has ended");
      const hiddenSend = expect(current.props.send()).rejects.toThrow("view has ended");
      expect(current.signal.aborted).toBe(false);
      expect(state.send).toHaveBeenCalledOnce();
      expect(state.abort).not.toHaveBeenCalled();
      expect(state.draft).toBe("Current draft");

      if (sameTurnReturn) {
        setPresented(true);
      }
      await hiddenSend;
      if (!sameTurnReturn) {
        await view.updateComplete;
        const hidden = contexts.at(-1);
        expect(hidden?.presented).toBe(false);
        expect(() => hidden?.props.setDraft("Hidden draft")).toThrow("view has ended");
      }
      setPresented(true);
      expect(() => current.props.setDraft("Revived draft")).toThrow("view has ended");
      send.resolve(true);
      await pending;
      flush();
      await view.updateComplete;

      expect(roots).toHaveLength(1);
      expect(view.querySelector("[data-plugin-view-root]")).toBe(roots[0]);
      expect(roots[0]?.textContent).toBe("Retained local view state");
      expect(dispose).not.toHaveBeenCalled();
      await expect(current.host.request("fixture.retained-view")).resolves.toEqual({ ok: true });
      expect(request).toHaveBeenCalledOnce();
      const successor = contexts.at(-1)!;
      expect(successor).not.toBe(current);
      expect(successor.presented).toBe(true);
      expect(successor.signal).toBe(current.signal);
      successor.props.setDraft("Successor draft");
      expect(state.draft).toBe("Successor draft");
      await expect(successor.props.send()).resolves.toBe(true);
      successor.props.abort?.();
      expect(state.abort).toHaveBeenCalledOnce();
      expect(() => current.props.setDraft("Still retired")).toThrow("view has ended");
    },
  );

  it("restores retained navigation when a workspace replacement's final update is pending", async () => {
    const { host, state, select } = mountSurface();
    const navigate = vi.fn();
    const link = document.createElement("button");
    link.textContent = "Open plugin page";
    link.addEventListener("click", navigate);
    state.navigation.append(link);
    flush();

    select(
      replacement("workspace", (container) => {
        container.textContent = "Custom workspace";
      }),
    );
    await vi.waitFor(() => expect(host.textContent).toBe("Custom workspace"));
    const retired = pluginView(host);
    expect(link.isConnected).toBe(false);

    select();
    await vi.waitFor(() => expect(host.querySelector("openclaw-plugin-view")).toBeNull());
    await retired.updateComplete;
    expect(host.querySelector("nav")).toBe(state.navigation);
    expect(link.isConnected).toBe(true);
    link.click();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("reports fatal async errors only for the current mount and disposes synchronous failures", async () => {
    const contexts: ControlUiViewContext<ControlUiSurfaceProps["workspace"]>[] = [];
    const dispose = vi.fn();
    let failSynchronously = true;
    const { host, reportError } = mountSurface({
      id: "fatal",
      label: "Fatal",
      surface: "workspace",
      mount(container, context) {
        contexts.push(context);
        container.textContent = "Current plugin content";
        if (failSynchronously) {
          context.reportError?.(new Error("Initial load failed"));
        }
        return { dispose };
      },
    });
    await vi.waitFor(() =>
      expect(host.querySelector("[role=alert]")?.textContent).toContain("Initial load failed"),
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(contexts[0]?.signal.aborted).toBe(true);
    failSynchronously = false;
    host.querySelector<HTMLButtonElement>("[role=alert] button")!.click();
    await vi.waitFor(() => expect(contexts).toHaveLength(2));
    contexts[0]?.reportError?.(new Error("Late retired error"));
    flush();
    expect(host.querySelector("[role=alert]")).toBeNull();
    contexts[1]?.reportError?.(new Error("Current request failed"));
    await vi.waitFor(() =>
      expect(host.querySelector("[role=alert]")?.textContent).toContain("Current request failed"),
    );
    expect(contexts[1]?.signal.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("aborts an invalidated view that fails during update and remounts it on retry", async () => {
    const roots: HTMLElement[] = [];
    const signals: AbortSignal[] = [];
    const dispose = vi.fn();
    const failure = new Error("Deferred page unavailable");
    let failUpdate = false;
    let invalidate = () => {};
    const { host, reportError, listeners } = mountSurface(
      replacement("workspace", (container, context) => {
        roots.push(container);
        signals.push(context.signal);
        invalidate = context.host.ui.invalidate;
        container.textContent = "Page content";
        return {
          update() {
            if (failUpdate) {
              throw failure;
            }
          },
          dispose,
        };
      }),
    );
    flush();
    const view = pluginView(host);
    await view.updateComplete;
    failUpdate = true;
    invalidate();
    await view.updateComplete;
    await view.updateComplete;
    expect(signals[0]?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledExactlyOnceWith("review", failure);
    expect(view.querySelector("[role=alert]")?.textContent).toContain(failure.message);
    for (const notify of listeners) {
      notify();
    }
    await view.updateComplete;
    expect(roots).toHaveLength(1);
    expect(reportError).toHaveBeenCalledOnce();
    failUpdate = false;
    view.querySelector<HTMLButtonElement>("[role=alert] button")!.click();
    await view.updateComplete;
    expect(roots).toHaveLength(2);
    expect(roots[1]).not.toBe(roots[0]);
    expect(signals[1]?.aborted).toBe(false);
    expect(view.textContent).toBe("Page content");
  });

  it("gives append-only views fresh roots across replacement, session changes, and reconnection", async () => {
    const roots: HTMLElement[] = [];
    const signals: AbortSignal[] = [];
    const mountedViews: ControlUiViewContext<ControlUiSurfaceProps["workspace"]>[] = [];
    const appendOnly = replacement("workspace", (container, context) => {
      roots.push(container);
      signals.push(context.signal);
      mountedViews.push(context);
      container.append(document.createTextNode("Plugin content"));
    });
    const { view, provider, listeners, select, request } = mountView(appendOnly);
    const navigation = document.createElement("nav");
    view.mountDefaultView = (target) => {
      target.append(navigation);
      return () => navigation.remove();
    };
    await vi.waitFor(() => expect(roots).toHaveLength(1));
    select({ ...appendOnly });
    await vi.waitFor(() => expect(roots).toHaveLength(2));
    expect(roots[1]).not.toBe(roots[0]);
    expect(signals[0]?.aborted).toBe(true);
    expect(view.textContent).toBe("Plugin content");

    view.props = { sessionKey: "other-session", agentId: "main", routeId: "chat" };
    await vi.waitFor(() => expect(roots).toHaveLength(3));
    expect(roots[2]).not.toBe(roots[1]);
    expect(signals[1]?.aborted).toBe(true);
    expect(view.textContent).toBe("Plugin content");

    const navigationParent = navigation.parentNode;
    const defaultTarget = document.createElement("div");
    view.remove();
    expect(() => mountedViews[2]!.mountDefault(defaultTarget)).toThrow("view has ended");
    expect(defaultTarget.childNodes).toHaveLength(0);
    expect(navigation.parentNode).toBe(navigationParent);
    const detachedRequest = mountedViews[2]!.host.request("fixture.detached-view");
    expect(request).not.toHaveBeenCalled();
    await expect(detachedRequest).rejects.toThrow("view has ended");
    await Promise.resolve();
    expect(signals[2]?.aborted).toBe(true);
    expect(listeners.size).toBe(0);
    view.presented = false;
    view.props = structuredClone(view.props);
    await view.updateComplete;
    expect(roots).toHaveLength(3);
    provider.append(view);
    await vi.waitFor(() => expect(roots).toHaveLength(4));
    expect(roots[3]).not.toBe(roots[2]);
    expect(signals[3]?.aborted).toBe(false);
    expect(view.textContent).toBe("Plugin content");
    expect(view.presented).toBe(false);
  });
});
