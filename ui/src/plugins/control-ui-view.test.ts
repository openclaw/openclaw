import { html, LitElement } from "lit";
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
  PRESENTATION_CHANGED_EVENT,
  type PresentationBinding,
} from "../lit/presentation-binding.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { renderPluginSurface } from "./control-ui-view.ts";
import "./control-ui-view.solid.tsx";
import "./control-ui-contributions.solid.tsx";

function increment(this: SurfaceTestHost) {
  this.count += 1;
}

class SurfaceTestHost extends LitElement {
  count = 0;
  sessionKey = "main";
  agentId = "main";
  surface: "workspace" | "composer" = "workspace";
  draft = "";
  presentation?: PresentationBinding;
  readonly setDraft = vi.fn((draft: string) => {
    this.draft = draft;
  });
  readonly send = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  readonly abort = vi.fn();
  readonly navigation = document.createElement("nav");
  override createRenderRoot() {
    return this;
  }
  override render() {
    const identity = { sessionKey: this.sessionKey, agentId: this.agentId };
    const defaultView = html`<button class="builtin-action" @click=${increment}>
        Built-in action
      </button>
      <input class="builtin-input" aria-label="Built-in input" />
      ${this.navigation}`;
    if (this.surface === "composer") {
      return renderPluginSurface(
        "composer",
        {
          ...identity,
          draft: this.draft,
          canSend: true,
          sending: false,
          disabledReason: null,
          setDraft: this.setDraft,
          send: this.send,
          abort: this.abort,
        },
        defaultView,
        this.presentation ?? true,
        html`<button class="companion-action">Retained attachment controls</button>`,
      );
    }
    return renderPluginSurface(
      "workspace",
      { ...identity, routeId: "chat" },
      defaultView,
      this.presentation ?? true,
    );
  }
}
customElements.define("control-ui-surface-test-host", SurfaceTestHost);

function mountSurface(initial?: ControlUiReplacement<"workspace" | "composer">) {
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
  const provider = createApplicationContextProvider(context);
  const host = document.createElement("control-ui-surface-test-host") as SurfaceTestHost;
  host.surface = initial?.surface ?? "workspace";
  provider.append(host);
  document.body.append(provider);
  return {
    host,
    provider,
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

afterEach(() => {
  document.body.replaceChildren();
});

describe("native UI built-in delegation", () => {
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
    const { host, provider, select, listeners } = mountSurface({
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
    host.remove();
    const view = document.createElement("openclaw-plugin-view");
    view.mountDefaultView = mountDefaultView;
    provider.append(view);
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
    const { host } = mountSurface({
      id: "composer",
      label: "Custom composer",
      surface: "composer",
      mount(container, context) {
        stopDefault = context.mountDefault(container);
        return { dispose: () => stopDefault?.() };
      },
    });
    await vi.waitFor(() => expect(host.querySelector(".builtin-action")).not.toBeNull());
    expect(host.querySelectorAll(".builtin-action")).toHaveLength(1);
    expect(host.querySelector(".companion-action")).toBeNull();
    stopDefault?.();
    await vi.waitFor(() => expect(host.querySelector(".companion-action")).not.toBeNull());
    expect(host.querySelector(".builtin-action")).toBeNull();
  });

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
    const { host, request, select } = mountSurface(replacement);
    host.sessionKey = "global";
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    const current = contexts[0];
    const view =
      host.querySelector<HTMLElementTagNameMap["openclaw-plugin-view"]>("openclaw-plugin-view");
    if (!current || !view) {
      throw new Error("Expected the composer replacement to mount");
    }
    current.props.setDraft("Current draft");
    expect(host.draft).toBe("Current draft");

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
    expect(host.draft).toBe("Current draft");
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
    expect(host.draft).toBe("Successor draft");
  });

  it.each([
    { sameTurnReturn: false, retainedParent: false },
    { sameTurnReturn: true, retainedParent: false },
    { sameTurnReturn: false, retainedParent: true },
    { sameTurnReturn: true, retainedParent: true },
  ])(
    "retires hidden composer operations (same-turn return: $sameTurnReturn, parked parent: $retainedParent)",
    async ({ sameTurnReturn, retainedParent }) => {
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
      const { host, request } = mountSurface(replacement);
      let presented = true;
      if (retainedParent) {
        host.presentation = { owner: host, isPresented: () => presented };
      }
      await vi.waitFor(() => expect(roots).toHaveLength(1));
      const current = contexts.at(-1);
      const view =
        host.querySelector<HTMLElementTagNameMap["openclaw-plugin-view"]>("openclaw-plugin-view");
      if (!current || !view) {
        throw new Error("Expected the composer replacement to mount");
      }
      current.props.setDraft("Current draft");
      const send = createDeferred<boolean>();
      host.send.mockReturnValueOnce(send.promise);
      const pending = expect(current.props.send()).rejects.toThrow("view has ended");
      const setPresented = (value: boolean) => {
        if (retainedParent) {
          presented = value;
          host.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
          if (value) {
            host.requestUpdate();
          }
        } else {
          view.presented = value;
        }
      };

      setPresented(false);
      // Presentation retires operations synchronously without retiring the mounted host.
      expect(() => current.props.setDraft("Stale draft")).toThrow("view has ended");
      expect(() => current.props.abort?.()).toThrow("view has ended");
      const hiddenSend = expect(current.props.send()).rejects.toThrow("view has ended");
      expect(current.signal.aborted).toBe(false);
      expect(host.send).toHaveBeenCalledOnce();
      expect(host.abort).not.toHaveBeenCalled();
      expect(host.draft).toBe("Current draft");

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
      await host.updateComplete;
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
      expect(host.draft).toBe("Successor draft");
      await expect(successor.props.send()).resolves.toBe(true);
      successor.props.abort?.();
      expect(host.abort).toHaveBeenCalledOnce();
      expect(() => current.props.setDraft("Still retired")).toThrow("view has ended");
    },
  );

  it("restores retained navigation when a workspace replacement's final update is pending", async () => {
    const { host, select } = mountSurface();
    const navigate = vi.fn();
    const link = document.createElement("button");
    link.textContent = "Open plugin page";
    link.addEventListener("click", navigate);
    host.navigation.append(link);
    await host.updateComplete;

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
    expect(host.querySelector("nav")).toBe(host.navigation);
    expect(link.isConnected).toBe(true);
    link.click();
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("keeps the built-in synchronous and preserves its event receiver through composition and failure recovery", async () => {
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
    const { host, reportError, listeners, select } = mountSurface();
    await host.updateComplete;
    expect(host.querySelector("openclaw-plugin-view")).toBeNull();
    host.querySelector<HTMLButtonElement>(".builtin-action")!.click();
    expect(host.count).toBe(1);

    select(replacement);
    await vi.waitFor(() =>
      expect(host.querySelector("openclaw-plugin-view button")).not.toBeNull(),
    );
    host.querySelector<HTMLButtonElement>(".builtin-action")!.click();
    expect(host.count).toBe(2);

    select();
    await vi.waitFor(() => expect(host.querySelector("openclaw-plugin-view")).toBeNull());
    host.querySelector<HTMLButtonElement>(".builtin-action")!.click();
    expect(host.count).toBe(3);
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
    expect(host.count).toBe(4);
    expect(reportError).toHaveBeenCalledWith("review", failure);
    const input = host.querySelector<HTMLInputElement>(".builtin-input")!;
    input.value = "Unsent input";
    input.focus();
    host.requestUpdate();
    await host.updateComplete;
    await host.querySelector("openclaw-plugin-view")!.updateComplete;
    expect(host.querySelector(".builtin-input")).toBe(input);
    expect(input.value).toBe("Unsent input");
    expect(document.activeElement).toBe(input);
    host.remove();
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
    await host.updateComplete;
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
    const { host, provider, listeners, select, request } = mountSurface(replacement);
    let presented = true;
    host.presentation = { owner: host, isPresented: () => presented };
    await vi.waitFor(() => expect(roots).toHaveLength(1));
    select({ ...replacement });
    await vi.waitFor(() => expect(roots).toHaveLength(2));
    expect(roots[1]).not.toBe(roots[0]);
    expect(signals[0]?.aborted).toBe(true);
    expect(host.textContent).toBe("Plugin content");

    host.sessionKey = "other-session";
    host.requestUpdate();
    await vi.waitFor(() => expect(roots).toHaveLength(3));
    expect(roots[2]).not.toBe(roots[1]);
    expect(signals[1]?.aborted).toBe(true);
    expect(host.textContent).toBe("Plugin content");

    const navigationParent = host.navigation.parentNode;
    const defaultTarget = document.createElement("div");
    host.remove();
    expect(() => mountedViews[2]!.mountDefault(defaultTarget)).toThrow("view has ended");
    expect(defaultTarget.childNodes).toHaveLength(0);
    expect(host.navigation.parentNode).toBe(navigationParent);
    const detachedRequest = mountedViews[2]!.host.request("fixture.detached-view");
    expect(request).not.toHaveBeenCalled();
    await expect(detachedRequest).rejects.toThrow("view has ended");
    await Promise.resolve();
    expect(signals[2]?.aborted).toBe(true);
    expect(listeners.size).toBe(0);
    const view =
      host.querySelector<HTMLElementTagNameMap["openclaw-plugin-view"]>("openclaw-plugin-view")!;
    presented = false;
    host.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
    expect(view.presented).toBe(true);
    view.props = structuredClone(view.props);
    await view.updateComplete;
    expect(roots).toHaveLength(3);
    provider.append(host);
    await vi.waitFor(() => expect(roots).toHaveLength(4));
    expect(roots[3]).not.toBe(roots[2]);
    expect(signals[3]?.aborted).toBe(false);
    expect(host.textContent).toBe("Plugin content");
    expect(view.presented).toBe(false);
  });
});
