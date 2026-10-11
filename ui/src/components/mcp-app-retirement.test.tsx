/* @vitest-environment jsdom */
import { createSignal, onCleanup } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { McpAppRetirement } from "./mcp-app-retirement.tsx";

function mountRetirement() {
  const pending = createDeferred();
  const [identity, setIdentity] = createSignal("initial");
  const restart = vi.fn();
  const cleaned = vi.fn();
  const connectedAtTeardown: boolean[] = [];
  const teardown = vi.fn(function (this: HTMLElement) {
    connectedAtTeardown.push(this.isConnected);
    return pending.promise;
  });
  const renderedIdentities: string[] = [];
  let container!: HTMLDivElement;
  const mounted = mountSolid(() => (
    <div
      ref={(element) => {
        container = element;
      }}
    >
      <McpAppRetirement identity={identity()} roots={() => [container]}>
        {(value) => {
          renderedIdentities.push(value);
          onCleanup(() => cleaned(value));
          const target = document.createElement("mcp-app-view");
          target.setAttribute("data-identity", value);
          Object.assign(target, { teardown, restartAfterTeardown: restart });
          return target;
        }}
      </McpAppRetirement>
    </div>
  ));
  flush();
  return {
    ...mounted,
    pending,
    setIdentity,
    restart,
    cleaned,
    teardown,
    renderedIdentities,
    connectedAtTeardown,
  };
}

describe("Solid MCP App retirement", () => {
  it("keeps the old App connected until teardown settles and installs only the latest replacement", async () => {
    const view = mountRetirement();
    const original = view.container.querySelector("mcp-app-view")!;
    view.setIdentity("intermediate");
    flush();
    expect(original.isConnected).toBe(true);
    expect(view.connectedAtTeardown).toEqual([true]);
    expect(view.container.querySelector("mcp-app-view")).toBe(original);
    expect(view.cleaned).not.toHaveBeenCalled();

    view.setIdentity("latest");
    flush();
    expect(original.isConnected).toBe(true);
    expect(view.renderedIdentities).toEqual(["initial"]);
    expect(view.teardown).toHaveBeenCalledOnce();

    view.pending.resolve();
    await waitForSolid(() => {
      expect(view.container.querySelector("mcp-app-view")?.getAttribute("data-identity")).toBe(
        "latest",
      );
    });
    expect(original.isConnected).toBe(false);
    expect(view.renderedIdentities).toEqual(["initial", "latest"]);
    expect(view.restart).not.toHaveBeenCalled();
    expect(view.cleaned.mock.calls).toEqual([["initial"]]);
    view.unmount();
    expect(view.cleaned.mock.calls).toEqual([["initial"], ["latest"]]);
  });

  it("restarts the same retained App when a pending replacement is cancelled", async () => {
    const view = mountRetirement();
    const original = view.container.querySelector("mcp-app-view")!;
    view.setIdentity("intermediate");
    flush();
    view.setIdentity("initial");
    flush();
    expect(original.isConnected).toBe(true);
    expect(view.restart).not.toHaveBeenCalled();
    expect(view.cleaned).not.toHaveBeenCalled();

    view.pending.resolve();
    await waitForSolid(() => expect(view.restart).toHaveBeenCalledOnce());
    expect(view.container.querySelector("mcp-app-view")).toBe(original);
    expect(view.renderedIdentities).toEqual(["initial"]);
    expect(view.connectedAtTeardown).toEqual([true]);
    expect(view.teardown).toHaveBeenCalledOnce();
    expect(view.cleaned).not.toHaveBeenCalled();
    view.unmount();
    expect(view.cleaned.mock.calls).toEqual([["initial"]]);
  });
});
