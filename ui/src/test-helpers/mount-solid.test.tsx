import { fireEvent } from "@solidjs/testing-library";
import { createContext, createEffect, createSignal, onCleanup, useContext } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "./mount-solid.ts";
import { renderSolidRef } from "./render-solid-ref.ts";
import { flush, waitForSolid } from "./solid-settle.ts";

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

  it("keeps caller-owned containers and isolates sibling mounts", () => {
    const parent = document.createElement("section");
    const container = parent.appendChild(document.createElement("div"));
    const first = mountSolid(() => <p>First</p>, { container });
    const second = mountSolid(() => <p>Second</p>, { baseElement: parent });
    first.unmount();
    expect(container.parentNode).toBe(parent);
    expect(container.textContent).toBe("");
    expect(second.getByText("Second")).toBeTruthy();
    second.unmount();
    expect(parent.children).toHaveLength(1);
  });

  it("cleans failed mounts before propagating their error", () => {
    const disposed = vi.fn();
    const container = document.createElement("div");
    expect(() =>
      mountSolid(
        () => {
          onCleanup(disposed);
          throw new Error("Mount failed");
        },
        { container },
      ),
    ).toThrow("Mount failed");
    expect(disposed).toHaveBeenCalledOnce();
    expect(container.childNodes).toHaveLength(0);
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

it("forwards ref container and provider options with owned setup and unowned application", () => {
  const Context = createContext<string>();
  const container = document.createElement("div");
  const target = document.createElement("button");
  const disposed = vi.fn();
  const view = renderSolidRef(
    () => {
      const label = useContext(Context);
      onCleanup(disposed);
      return (element: HTMLButtonElement) => {
        element.textContent = label;
      };
    },
    {
      container,
      targetElement: target,
      wrapper: (props) => <Context value="Provided label">{props.children}</Context>,
    },
  );
  expect(view.container).toBe(container);
  expect(view.getByRole("button", { name: "Provided label" })).toBe(target);
  view.unmount();
  expect(disposed).toHaveBeenCalledOnce();
});

it("waits for an asynchronous outcome instead of counting microtask turns", async () => {
  const [value, setValue] = createSignal("Loading");
  const view = mountSolid(() => <output>{value()}</output>);
  let resolve!: (value: string) => void;
  const response = new Promise<string>((done) => {
    resolve = done;
  });
  void response.then(setValue);
  flush();
  expect(view.container.textContent).toBe("Loading");
  resolve("Ready");
  await waitForSolid(() => expect(view.container.textContent).toBe("Ready"));
});
