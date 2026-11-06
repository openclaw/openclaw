/* @vitest-environment jsdom */
import { createSignal, onCleanup } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { McpAppRetirement } from "./mcp-app-retirement.tsx";
import { registerMcpAppUnmountTarget } from "./mcp-app-unmount.ts";

function mountRetirement() {
  const pending = createDeferred();
  const [identity, setIdentity] = createSignal("initial");
  const state = {
    restart: vi.fn(),
    cleaned: vi.fn(),
    connected: [] as boolean[],
    rendered: [] as string[],
  };
  const teardown = vi.fn(function (this: HTMLElement) {
    state.connected.push(this.isConnected);
    return pending.promise;
  });
  let container!: HTMLDivElement;
  const mounted = mountSolid(() => (
    <div ref={(element) => (container = element)}>
      <McpAppRetirement identity={identity()} roots={() => [container]}>
        {(value) => {
          state.rendered.push(value);
          onCleanup(() => state.cleaned(value));
          const target = document.createElement("mcp-app-view");
          target.setAttribute("data-identity", value);
          Object.assign(target, { teardown, restartAfterTeardown: state.restart });
          onCleanup(registerMcpAppUnmountTarget(target));
          return target;
        }}
      </McpAppRetirement>
    </div>
  ));
  flush();
  return { ...mounted, ...state, pending, setIdentity, teardown };
}

it.each(["latest", "initial"])(
  "retains the App during retirement, then settles the latest identity %s",
  async (next) => {
    const view = mountRetirement();
    const cancelled = next === "initial";
    const original = view.container.querySelector("mcp-app-view")!;
    view.setIdentity("intermediate");
    flush();
    expect(original.isConnected).toBe(true);
    expect(view.connected).toEqual([true]);
    expect(view.container.querySelector("mcp-app-view")).toBe(original);
    expect(view.cleaned).not.toHaveBeenCalled();

    view.setIdentity(next);
    flush();
    expect(original.isConnected).toBe(true);
    expect(view.rendered).toEqual(["initial"]);
    expect(view.teardown).toHaveBeenCalledOnce();
    expect(view.restart).not.toHaveBeenCalled();
    expect(view.cleaned).not.toHaveBeenCalled();
    const identities = cancelled ? ["initial"] : ["initial", "latest"];
    view.pending.resolve();
    await waitForSolid(() => {
      expect(view.rendered).toEqual(identities);
      expect(view.restart).toHaveBeenCalledTimes(cancelled ? 1 : 0);
    });
    const current = view.container.querySelector("mcp-app-view");
    expect(current?.getAttribute("data-identity")).toBe(next);
    expect(current === original).toBe(cancelled);
    expect(original.isConnected).toBe(cancelled);
    expect(view.connected).toEqual([true]);
    expect(view.teardown).toHaveBeenCalledOnce();
    expect(view.cleaned.mock.calls).toEqual(cancelled ? [] : [["initial"]]);
    view.unmount();
    expect(view.cleaned.mock.calls).toEqual(identities.map((identity) => [identity]));
  },
);
