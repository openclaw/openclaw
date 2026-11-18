import { fireEvent } from "@solidjs/testing-library";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "./mount-solid.ts";
import { flush } from "./solid-settle.ts";

describe("mountSolid", () => {
  it("updates through DOM events and disposes effects and owned DOM exactly once", () => {
    const observed = vi.fn();
    const disposed = vi.fn();
    const [count, setCount] = createSignal(0);
    const view = mountSolid(() => {
      createEffect(count, observed);
      onCleanup(disposed);
      return <button onClick={() => setCount((value) => value + 1)}>Count {count()}</button>;
    });
    const button = view.getByRole("button", { name: "Count 0" });
    fireEvent.click(button);
    flush();
    expect(button.textContent).toBe("Count 1");
    expect(observed).toHaveBeenCalledTimes(2);
    view.unmount();
    cleanupSolid();
    view.unmount();
    setCount(2);
    flush();
    expect(observed).toHaveBeenCalledTimes(2);
    expect(disposed).toHaveBeenCalledOnce();
    expect(view.container.isConnected).toBe(false);
    expect(view.container.childNodes).toHaveLength(0);
  });

  it("retires every root even when one cleanup throws", () => {
    const disposed = vi.fn();
    const failing = mountSolid(() => {
      onCleanup(() => {
        throw new Error("Cleanup failed");
      });
      return <p>Failing</p>;
    });
    const survivor = mountSolid(() => {
      onCleanup(disposed);
      return <p>Survivor</p>;
    });
    expect(cleanupSolid).toThrow("Solid test root cleanup failed");
    expect(disposed).toHaveBeenCalledOnce();
    expect(failing.container.isConnected).toBe(false);
    expect(survivor.container.isConnected).toBe(false);
  });
});
