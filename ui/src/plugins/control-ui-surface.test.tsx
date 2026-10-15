import { createSignal, onCleanup } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type {
  ControlUiHost,
  ControlUiReplacement,
  ControlUiSurfaceProps,
  ControlUiViewContext,
} from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { PluginSurface } from "./control-ui-view.solid.tsx";

function runtime(initial?: ControlUiReplacement) {
  let selected = initial;
  const listeners = new Set<() => void>();
  const abort = new AbortController();
  // SAFETY: these tests exercise only the view mount and scoped host request boundary.
  const host = {
    signal: abort.signal,
    request: vi.fn(),
    sessions: {},
    agents: {},
    navigation: {},
    ui: {},
    components: {},
  } as unknown as ControlUiHost;
  const reportError = vi.fn();
  // SAFETY: PluginSurface reads only the plugin capability supplied by this fixture.
  const context = {
    plugins: {
      selectedReplacement: () =>
        selected
          ? {
              key: "example/view",
              pluginId: "example",
              value: selected,
              host,
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
    listeners,
    reportError,
    select(value?: ControlUiReplacement) {
      selected = value;
      for (const listener of listeners) {
        listener();
      }
    },
    invalidate() {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

describe("native plugin surface", () => {
  it("keeps native defaults reactive through delegation and failure recovery", async () => {
    const source = runtime();
    const provider = createSolidApplicationContextProvider(source.context);
    const [label, setLabel] = createSignal("First");
    const click = vi.fn();
    const disposed = vi.fn();
    const contexts: ApplicationContext[] = [];
    let fail = false;
    function DefaultView() {
      contexts.push(useApplication());
      onCleanup(disposed);
      return <button onClick={click}>{label()}</button>;
    }
    const view = mountSolid(
      () => (
        <PluginSurface
          surface="workspace"
          props={{ sessionKey: "main", agentId: "main", routeId: "chat" }}
          renderDefault={() => <DefaultView />}
          renderCompanion={() => <span>Companion</span>}
        />
      ),
      { wrapper: provider.wrapper },
    );
    expect(view.container.querySelector("openclaw-plugin-view")).toBeNull();
    view.getByRole("button", { name: "First" }).click();
    expect(click).toHaveBeenCalledOnce();
    source.select({
      id: "delegate",
      label: "Delegate",
      surface: "workspace",
      mount(container, context) {
        context.mountDefault(container);
        return {
          update() {
            if (fail) {
              throw new Error("Replacement failed");
            }
          },
        };
      },
    });
    await waitForSolid(() => expect(view.getAllByRole("button")).toHaveLength(1));
    const delegated = view.getByRole("button", { name: "First" });
    expect(view.queryByText("Companion")).toBeNull();
    setLabel("Second");
    flush();
    expect(view.getByRole("button", { name: "Second" })).toBe(delegated);
    delegated.click();
    expect(click).toHaveBeenCalledTimes(2);
    fail = true;
    source.invalidate();
    await waitForSolid(() =>
      expect(view.getByRole("alert").textContent).toContain("Replacement failed"),
    );
    expect(view.getAllByRole("button", { name: "Second" })).toHaveLength(1);
    expect(view.queryByText("Companion")).toBeNull();
    expect(source.reportError).toHaveBeenCalledOnce();
    expect(contexts.every((context) => context === source.context)).toBe(true);
    source.select();
    await waitForSolid(() =>
      expect(view.container.querySelector("openclaw-plugin-view")).toBeNull(),
    );
    view.getByRole("button", { name: "Second" }).click();
    expect(click).toHaveBeenCalledTimes(3);
    view.unmount();
    expect(disposed).toHaveBeenCalledTimes(contexts.length);
    expect(source.listeners.size).toBe(0);
  });

  it("revokes deselected composer operations before rendering and retires replaced contexts", async () => {
    const mounted: ControlUiViewContext<ControlUiSurfaceProps["composer"]>[] = [];
    const roots: HTMLElement[] = [];
    const dispose = vi.fn();
    const replacement: ControlUiReplacement<"composer"> = {
      id: "composer",
      label: "Composer",
      surface: "composer",
      mount(container, context) {
        roots.push(container);
        mounted.push(context);
        container.textContent = "Plugin composer";
        return { dispose };
      },
    };
    const source = runtime(replacement);
    const next = runtime(replacement);
    const provider = createSolidApplicationContextProvider(source.context);
    const setDraft = vi.fn();
    const view = mountSolid(
      () => (
        <PluginSurface
          surface="composer"
          props={{
            sessionKey: "main",
            agentId: "main",
            draft: "",
            canSend: true,
            sending: false,
            disabledReason: null,
            setDraft,
            send: async () => true,
          }}
          renderDefault={() => <textarea aria-label="Built-in composer" />}
          renderCompanion={() => <span>Companion</span>}
        />
      ),
      { wrapper: provider.wrapper },
    );
    await waitForSolid(() => expect(mounted).toHaveLength(1));
    expect(view.getByText("Companion")).toBeDefined();
    const first = mounted[0]!;
    first.props.setDraft("Current");
    source.select();
    source.select(replacement);
    expect(() => first.props.setDraft("Retired")).toThrow("view has ended");
    expect(first.signal.aborted).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
    await waitForSolid(() => expect(mounted).toHaveLength(2));
    expect(roots[1]).not.toBe(roots[0]);
    provider.setContext(next.context);
    await waitForSolid(() => expect(mounted).toHaveLength(3));
    expect(mounted[1]?.signal.aborted).toBe(true);
    expect(source.listeners.size).toBe(0);
    expect(roots[2]).not.toBe(roots[1]);
    mounted[2]!.props.setDraft("Replacement context");
    expect(setDraft.mock.calls).toEqual([["Current"], ["Replacement context"]]);
    view.unmount();
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(next.listeners.size).toBe(0);
  });
});
