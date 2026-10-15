import { createEffect, createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiReplacement,
  ControlUiSurfaceProps,
  ControlUiViewContext,
} from "../../../src/plugin-sdk/control-ui.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import {
  renderLegacyTemplate,
  solidContent,
  SolidContentPresentation,
} from "../lit/solid-content.tsx";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { flush } from "../test-helpers/solid-settle.ts";
import { PluginSurface } from "./control-ui-view.solid.tsx";
import "./control-ui-contributions.solid.tsx";

function createRuntime(initial?: ControlUiReplacement<"workspace" | "composer">) {
  const listeners = new Set<() => void>();
  const abort = new AbortController();
  const request = vi.fn().mockResolvedValue({ ok: true });
  const pluginHost = {
    signal: abort.signal,
    request,
    sessions: {},
    agents: {},
    navigation: {},
    ui: {
      invalidate: () => {
        for (const listener of listeners) {
          listener();
        }
      },
    },
    components: {},
  } as unknown as ControlUiHost;
  const reportError = vi.fn();
  let selected = initial;
  const context = {
    plugins: {
      selectedReplacement: () =>
        selected
          ? {
              key: "review/composed",
              pluginId: "review",
              value: selected,
              host: pluginHost,
              signal: abort.signal,
            }
          : undefined,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      reportError,
    },
  } as unknown as ApplicationContext;
  return {
    context,
    reportError,
    listeners,
    request,
    select: (replacement?: ControlUiReplacement<"workspace" | "composer">) => {
      selected = replacement;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

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
      <SolidContentPresentation value={contentPresented}>
        {initial?.surface === "composer" ? (
          <PluginSurface
            surface="composer"
            presented={presented()}
            props={{
              ...identity(),
              draft: state.draft,
              canSend: true,
              sending: false,
              disabledReason: null,
              setDraft: state.setDraft,
              send: state.send,
              abort: state.abort,
            }}
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
      </SolidContentPresentation>
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

afterEach(() => {
  document.body.replaceChildren();
});

describe("native UI built-in delegation", () => {
  it("updates and disposes a native default from a plugin effect without nested flushes", () => {
    const warning = vi.spyOn(console, "warn");
    const disposed = vi.fn();
    const [label, setLabel] = createSignal("First");
    function DefaultView(props: { label: string }) {
      const button = document.createElement("button");
      createEffect(
        () => props.label,
        (value) => {
          button.textContent = value;
        },
      );
      onCleanup(disposed);
      return button;
    }
    const view = mountSolid(() => {
      const owner = getOwner();
      const target = document.createElement("div");
      createEffect(label, (value) =>
        runWithOwner(owner, () =>
          renderLegacyTemplate(solidContent(DefaultView, { label: value }), target),
        ),
      );
      onCleanup(() => renderLegacyTemplate(undefined, target));
      return target;
    });
    const button = view.getByRole("button", { name: "First" });
    setLabel("Second");
    flush();
    expect(view.getByRole("button", { name: "Second" })).toBe(button);
    expect(
      warning.mock.calls.flat().some((value) => String(value).includes("FLUSH_IN_EFFECT_CALLBACK")),
    ).toBe(false);
    view.unmount();
    expect(button.isConnected).toBe(false);
    expect(disposed).toHaveBeenCalledOnce();
    expect(
      warning.mock.calls.flat().some((value) => String(value).includes("RUN_WITH_DISPOSED_OWNER")),
    ).toBe(false);
    warning.mockRestore();
  });

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
    const { view, select, listeners } = mountView({
      id: "renderer-defaults",
      label: "Renderer defaults",
      surface: "workspace",
      mount(container, context) {
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
      },
    });
    view.mountDefaultView = mountDefaultView;
    await view.updateComplete;
    expect(mounted).toHaveLength(3);
    expect(view.querySelectorAll("button")).toHaveLength(2);
    expect(disposed).toEqual(mounted.slice(0, 1));
    failUpdate = true;
    for (const listener of listeners) {
      listener();
    }
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

  it("keeps host controls beside a replacement and removes them when the built-in returns", async () => {
    const replacement: ControlUiReplacement<"composer"> = {
      id: "composer",
      label: "Custom composer",
      surface: "composer",
      mount(container) {
        container.textContent = "Custom draft";
        return { update() {}, dispose() {} };
      },
    };
    const { host, select } = mountSurface(replacement);
    await vi.waitFor(() => expect(host.querySelector(".companion-action")).not.toBeNull());
    expect(host.querySelector(".builtin-action")).toBeNull();
    select();
    await vi.waitFor(() => expect(host.querySelector(".builtin-action")).not.toBeNull());
    expect(host.querySelector(".companion-action")).toBeNull();
    select(replacement);
    await vi.waitFor(() => expect(host.querySelector(".companion-action")).not.toBeNull());
  });

  it("uses only built-in controls when a replacement composer fails", async () => {
    const { host } = mountSurface({
      id: "composer",
      label: "Custom composer",
      surface: "composer",
      mount() {
        throw new Error("Composer failed");
      },
    });
    await vi.waitFor(() => expect(host.querySelector(".builtin-action")).not.toBeNull());
    expect(host.querySelectorAll(".builtin-action")).toHaveLength(1);
    expect(host.querySelector(".companion-action")).toBeNull();
  });

  it("restores host controls when a replacement stops delegating to the built-in", async () => {
    let stopDefault: (() => void) | undefined;
    const toolbar = document.createElement("button");
    toolbar.textContent = "Plugin action";
    const clicked = vi.fn();
    toolbar.addEventListener("click", clicked);
    const status = document.createElement("output");
    status.textContent = "Plugin status";
    const { host } = mountSurface({
      id: "composer",
      label: "Custom composer",
      surface: "composer",
      mount(container, context) {
        container.append(toolbar);
        stopDefault = context.mountDefault(container);
        container.append(status);
        return { dispose: () => stopDefault?.() };
      },
    });
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
      const contexts: ControlUiViewContext<ControlUiSurfaceProps["workspace"]>[] = [];
      const dispose = vi.fn();
      const mount = vi.fn(
        (
          container: HTMLElement,
          context: ControlUiViewContext<ControlUiSurfaceProps["workspace"]>,
        ) => {
          contexts.push(context);
          container.textContent = "Retained plugin state";
          return { update: (next: typeof context) => contexts.push(next), dispose };
        },
      );

      setPresented(false);
      flush();
      expect(view.listeners.size).toBe(0);
      view.select({ id: "workspace", label: "Workspace", surface: "workspace", mount });
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
    const contexts: ControlUiViewContext<ControlUiSurfaceProps["composer"]>[] = [];
    const roots: HTMLElement[] = [];
    const dispose = vi.fn();
    const replacement: ControlUiReplacement<"composer"> = {
      id: "composer",
      label: "Custom composer",
      surface: "composer",
      mount(container, context) {
        contexts.push(context);
        roots.push(container);
        container.textContent = context.props.agentId;
        return { dispose };
      },
    };
    const { host, state, request, select } = mountSurface(replacement, "global");
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    const current = contexts[0];
    const view =
      host.querySelector<HTMLElementTagNameMap["openclaw-plugin-view"]>("openclaw-plugin-view");
    if (!current || !view) {
      throw new Error("Expected the composer replacement to mount");
    }
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
      select(replacement);
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
    const successor = contexts[1];
    if (!successor) {
      throw new Error("Expected a new composer owner to mount");
    }
    expect(successor.props.agentId).toBe(nextAgents?.at(-1) ?? "main");
    successor.props.setDraft("Successor draft");
    expect(state.draft).toBe("Successor draft");
  });

  it.each([false, true])(
    "retires hidden composer operations (same-turn return: %s)",
    async (sameTurnReturn) => {
      const contexts: ControlUiViewContext<ControlUiSurfaceProps["composer"]>[] = [];
      const roots: HTMLElement[] = [];
      const dispose = vi.fn();
      const replacement: ControlUiReplacement<"composer"> = {
        id: "composer",
        label: "Custom composer",
        surface: "composer",
        mount(container, context) {
          contexts.push(context);
          roots.push(container);
          container.textContent = "Retained local view state";
          return { update: (next) => contexts.push(next), dispose };
        },
      };
      const { host, state, request } = mountSurface(replacement);
      await vi.waitFor(() => expect(roots).toHaveLength(1));
      const current = contexts.at(-1);
      const view =
        host.querySelector<HTMLElementTagNameMap["openclaw-plugin-view"]>("openclaw-plugin-view");
      if (!current || !view) {
        throw new Error("Expected the composer replacement to mount");
      }
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
      const successor = contexts.at(-1);
      if (!successor || successor === current) {
        throw new Error("Expected fresh composer operations on return");
      }
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

    select({
      id: "workspace",
      label: "Custom workspace",
      surface: "workspace",
      mount(container) {
        container.textContent = "Custom workspace";
      },
    });
    await vi.waitFor(() => expect(host.textContent).toBe("Custom workspace"));
    const retired =
      host.querySelector<HTMLElementTagNameMap["openclaw-plugin-view"]>("openclaw-plugin-view")!;
    expect(link.isConnected).toBe(false);

    select();
    await vi.waitFor(() => expect(host.querySelector("openclaw-plugin-view")).toBeNull());
    await retired.updateComplete;
    expect(host.querySelector("nav")).toBe(state.navigation);
    expect(link.isConnected).toBe(true);
    link.click();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("preserves built-in controls through composition and failure recovery", async () => {
    const dispose = vi.fn();
    const replacement: ControlUiReplacement<"workspace"> = {
      id: "composed",
      label: "Composed workspace",
      surface: "workspace",
      mount(container, context) {
        const stop = context.mountDefault(container);
        return {
          dispose() {
            dispose();
            stop();
          },
        };
      },
    };
    const { host, state, reportError, listeners, select, update, unmount } = mountSurface();
    flush();
    expect(host.querySelector("openclaw-plugin-view")).toBeNull();
    host.querySelector<HTMLButtonElement>(".builtin-action")!.click();
    expect(state.count).toBe(1);

    select(replacement);
    await vi.waitFor(() =>
      expect(host.querySelector("openclaw-plugin-view button")).not.toBeNull(),
    );
    host.querySelector<HTMLButtonElement>(".builtin-action")!.click();
    expect(state.count).toBe(2);

    select();
    await vi.waitFor(() => expect(host.querySelector("openclaw-plugin-view")).toBeNull());
    host.querySelector<HTMLButtonElement>(".builtin-action")!.click();
    expect(state.count).toBe(3);
    expect(dispose).toHaveBeenCalledOnce();
    expect(reportError).not.toHaveBeenCalled();

    const failure = new Error("Plugin mount failed");
    select({
      ...replacement,
      mount() {
        throw failure;
      },
    });
    await vi.waitFor(() =>
      expect(host.querySelector("[role=alert]")?.textContent).toContain(failure.message),
    );
    host.querySelector<HTMLButtonElement>(".builtin-action")!.click();
    expect(state.count).toBe(4);
    expect(reportError).toHaveBeenCalledWith("review", failure);
    const input = host.querySelector<HTMLInputElement>(".builtin-input")!;
    input.value = "Unsent input";
    input.focus();
    update();
    flush();
    await host.querySelector("openclaw-plugin-view")!.updateComplete;
    expect(host.querySelector(".builtin-input")).toBe(input);
    expect(input.value).toBe("Unsent input");
    expect(document.activeElement).toBe(input);
    unmount();
    await Promise.resolve();
    expect(listeners.size).toBe(0);
  });

  it("aborts an invalidated view that fails during update and remounts it on retry", async () => {
    const roots: HTMLElement[] = [];
    const signals: AbortSignal[] = [];
    const dispose = vi.fn();
    const failure = new Error("Deferred page unavailable");
    let failUpdate = false;
    let invalidate = () => {};
    const { host, reportError } = mountSurface({
      id: "deferred",
      label: "Deferred workspace",
      surface: "workspace",
      mount(container, context) {
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
      },
    });
    flush();
    const view =
      host.querySelector<HTMLElementTagNameMap["openclaw-plugin-view"]>("openclaw-plugin-view")!;
    await view.updateComplete;
    failUpdate = true;
    invalidate();
    await view.updateComplete;
    await view.updateComplete;
    expect(signals[0]?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledExactlyOnceWith("review", failure);
    expect(view.querySelector("[role=alert]")?.textContent).toContain(failure.message);
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
    const replacement: ControlUiReplacement<"workspace"> = {
      id: "append-only",
      label: "Append-only workspace",
      surface: "workspace",
      mount(container, context) {
        roots.push(container);
        signals.push(context.signal);
        mountedViews.push(context);
        container.append(document.createTextNode("Plugin content"));
      },
    };
    const { view, provider, listeners, select, request } = mountView(replacement);
    const navigation = document.createElement("nav");
    view.defaultView = navigation;
    await vi.waitFor(() => expect(roots).toHaveLength(1));
    select({ ...replacement });
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
