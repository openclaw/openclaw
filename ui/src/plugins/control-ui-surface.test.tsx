import { createSignal, onCleanup } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { ControlUiReplacement } from "../../../src/plugin-sdk/control-ui.js";
import type { ApplicationContext } from "../app/context.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { PluginContribution, PluginSurface } from "./control-ui-view.solid.tsx";
import {
  composerProps,
  createInertViewHost,
  createViewRuntime,
  recordReplacement,
  replacement,
} from "./control-ui-view.test-support.ts";

function runtime(initial?: ControlUiReplacement) {
  return createViewRuntime(initial, {
    pluginId: "example",
    key: "example/view",
    request: vi.fn(),
    hostInvalidation: false,
  });
}

describe("native plugin surface", () => {
  it("keeps native defaults reactive through delegation and failure recovery", async () => {
    const source = runtime();
    const provider = createSolidApplicationContextProvider(source.context);
    const [label, setLabel] = createSignal("First");
    const click = vi.fn();
    const disposed = vi.fn();
    const releaseReplacement = vi.fn();
    const replacementRef = vi.fn(() => releaseReplacement);
    const [readReplacementRef] = createSignal(() => replacementRef);
    const warnings = vi.spyOn(console, "warn");
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
          replacementRef={readReplacementRef()}
        />
      ),
      { wrapper: provider.wrapper },
    );
    expect(view.container.querySelector("openclaw-plugin-view")).toBeNull();
    view.getByRole("button", { name: "First" }).click();
    expect(click).toHaveBeenCalledOnce();
    source.select(
      replacement("workspace", (container, context) => {
        context.mountDefault(container);
        return {
          update() {
            if (fail) {
              throw new Error("Replacement failed");
            }
          },
        };
      }),
    );
    await waitForSolid(() => expect(view.getAllByRole("button")).toHaveLength(1));
    expect(replacementRef).toHaveBeenCalledOnce();
    expect(releaseReplacement).not.toHaveBeenCalled();
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
    expect(releaseReplacement).toHaveBeenCalledOnce();
    view.getByRole("button", { name: "Second" }).click();
    expect(click).toHaveBeenCalledTimes(3);
    view.unmount();
    expect(releaseReplacement).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledTimes(contexts.length);
    expect(source.listeners.size).toBe(0);
    expect(
      warnings.mock.calls.some(([message]) => String(message).includes("STRICT_READ_UNTRACKED")),
    ).toBe(false);
    warnings.mockRestore();
  });

  it("mounts a routed page that settled before its parent inserted it", async () => {
    const source = runtime();
    const abort = new AbortController();
    const dispose = vi.fn();
    const mount = vi.fn((container: HTMLElement) => {
      container.textContent = "Projects page";
      return { dispose };
    });
    Object.assign(source.context.plugins, {
      registrations: (kind: string) =>
        kind === "pages"
          ? [
              {
                key: "example/projects",
                pluginId: "example",
                value: { id: "projects", label: "Projects", mount },
                host: createInertViewHost(abort.signal),
                signal: abort.signal,
              },
            ]
          : [],
    });
    const provider = createSolidApplicationContextProvider(source.context);
    // A workspace replacement builds the page before it appends its pane to the document.
    const detached = document.createElement("div");
    const view = mountSolid(
      () => <PluginContribution kind="pages" contributionKey="example/projects" props={{}} />,
      { wrapper: provider.wrapper, container: detached },
    );
    await waitForSolid(() => expect(detached.querySelector("openclaw-plugin-view")).not.toBeNull());
    expect(mount).not.toHaveBeenCalled();

    document.body.append(detached);
    await waitForSolid(() => expect(mount).toHaveBeenCalledOnce());
    expect(mount.mock.calls[0]![0].isConnected).toBe(true);
    expect(detached.textContent).toBe("Projects page");

    // Moving the mounted page keeps its plugin state instead of mounting it again.
    detached.remove();
    document.body.append(detached);
    flush();
    expect(mount).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    view.unmount();
    expect(dispose).toHaveBeenCalledOnce();
    detached.remove();
  });

  it("revokes deselected composer operations before rendering and retires replaced contexts", async () => {
    const record = recordReplacement("composer", "Plugin composer");
    const { contexts: mounted, roots, dispose } = record;
    const source = runtime(record.view);
    const next = runtime(record.view);
    const provider = createSolidApplicationContextProvider(source.context);
    const setDraft = vi.fn();
    const view = mountSolid(
      () => (
        <PluginSurface
          surface="composer"
          props={composerProps({ setDraft })}
          renderDefault={() => <textarea aria-label="Built-in composer" />}
          renderCompanion={() => <span>Companion</span>}
        />
      ),
      { wrapper: provider.wrapper },
    );
    await waitForSolid(() => expect(mounted).toHaveLength(1));
    expect(
      view.container.querySelector("openclaw-plugin-view[data-plugin-composer]"),
    ).not.toBeNull();
    expect(view.getByText("Companion")).toBeDefined();
    const first = mounted[0]!;
    first.props.setDraft("Current");
    source.select();
    source.select(record.view);
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
