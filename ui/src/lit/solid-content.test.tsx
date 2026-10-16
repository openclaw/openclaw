/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  onCleanup,
  onSettled,
  runWithOwner,
} from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { ContentPresentation as SolidContentPresentation } from "../lib/solid/presentation.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { LitContent, solidContent } from "./solid-content.tsx";

describe("Lit and Solid content boundaries", () => {
  it("settles parent refs after mounting nested Solid content through Lit", () => {
    const settled = vi.fn();
    const Nested = () => <span>Provider</span>;
    function Parent() {
      let sibling: HTMLButtonElement | undefined;
      onSettled(() => settled(sibling?.isConnected));
      return (
        <section>
          <LitContent value={html`${solidContent(Nested, {})}`} />
          <button ref={(element) => (sibling = element)}>Next</button>
        </section>
      );
    }
    mountSolid(() => <Parent />);
    flush();
    expect(settled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("updates a retained Lit boundary and clears its range before remounting", () => {
    const disconnected = vi.fn();
    class MediaContent extends AsyncDirective {
      render(value: string) {
        return value;
      }

      protected override disconnected() {
        disconnected();
      }
    }
    const media = directive(MediaContent);
    const content = (label: string) => html`<button>${media(label)}</button>`;
    const container = document.body.appendChild(document.createElement("div"));
    const [label, setLabel] = createSignal("First");
    const boundary = () => <LitContent value={content(label())} />;
    let mounted = mountSolid(boundary, { container });
    try {
      const button = container.querySelector("button")!;
      setLabel("Second");
      flush();
      expect(container.querySelector("button")).toBe(button);
      expect(button.textContent).toBe("Second");
      expect(disconnected).not.toHaveBeenCalled();

      mounted.unmount();
      mounted.unmount();
      expect(container.childNodes).toHaveLength(0);
      expect(disconnected).toHaveBeenCalledOnce();

      setLabel("Third");
      flush();
      mounted = mountSolid(boundary, { container });
      expect(container.querySelector("button")?.textContent).toBe("Third");
      expect(container.querySelector("button")).not.toBe(button);
      mounted.unmount();
      expect(container.childNodes).toHaveLength(0);
      expect(disconnected).toHaveBeenCalledTimes(2);
    } finally {
      mounted.unmount();
      container.remove();
    }
  });

  it("retires changed template roots when Solid removes a computed subtree", () => {
    const [shown, setShown] = createSignal(true);
    const [alternate, setAlternate] = createSignal(false);
    const view = mountSolid(() => {
      const content = createMemo(() =>
        shown() ? (
          <LitContent
            value={alternate() ? html`<article>Replacement</article>` : html`<p>Initial</p>`}
          />
        ) : undefined,
      );
      return (
        <section>
          {content()}
          <footer>Retained sibling</footer>
        </section>
      );
    });
    setAlternate(true);
    flush();
    const article = view.container.querySelector("article")!;
    expect(article.textContent).toBe("Replacement");

    setShown(false);
    expect(() => flush()).not.toThrow();
    expect(view.container.querySelector("article, p")).toBeNull();
    expect(view.container.querySelector("footer")?.textContent).toBe("Retained sibling");
    expect(article.isConnected).toBe(false);
  });

  it("reveals the current roots after an eager hidden outlet updates", () => {
    const [shown, setShown] = createSignal(false);
    const [value, setValue] = createSignal(html`<p>Original</p>`);
    const view = mountSolid(() => {
      const content = <LitContent value={value()} />;
      return (
        <section>
          <Show when={shown()}>{content}</Show>
          <footer>Retained</footer>
        </section>
      );
    });
    setValue(html`<article>Replacement</article>`);
    flush();
    setShown(true);
    flush();
    expect(view.container.querySelector("section > article")?.textContent).toBe("Replacement");
    expect(view.container.querySelector("p")).toBeNull();
    setValue(html`<div>Updated</div>`);
    flush();
    expect(view.container.querySelector("section > div")?.textContent).toBe("Updated");
    expect(view.container.querySelector("article")).toBeNull();
  });

  it("mounts and retires a delegated Solid default from a settled plugin callback", async () => {
    const disposed = vi.fn();
    function DefaultView() {
      onCleanup(disposed);
      return <button>Default composer</button>;
    }
    function DelegatedView() {
      return <LitContent value={html`${solidContent(DefaultView, {})}`} />;
    }
    function PluginSlot() {
      const owner = getOwner();
      let slot!: HTMLDivElement;
      onSettled(() => {
        runWithOwner(owner, () => render(solidContent(DelegatedView, {}), slot));
        return () => render(nothing, slot);
      });
      return (
        <div
          ref={(element) => {
            slot = element;
          }}
        />
      );
    }
    const view = mountSolid(() => <PluginSlot />);
    expect(view.getByRole("button", { name: "Default composer" })).toBeTruthy();
    view.unmount();
    await Promise.resolve();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("updates a stable Solid component through Lit without resetting focus or local state", async () => {
    const disposed = vi.fn();
    function Counter(props: { label: string }) {
      const [count, setCount] = createSignal(0);
      onCleanup(disposed);
      return (
        <button type="button" onClick={() => setCount((current) => current + 1)}>
          {props.label}: {count()}
        </button>
      );
    }
    const container = document.body.appendChild(document.createElement("div"));
    const update = (label: string) => render(html`${solidContent(Counter, { label })}`, container);
    try {
      update("First");
      const button = container.querySelector("button")!;
      button.focus();
      button.click();
      flush();
      expect(button.textContent).toBe("First: 1");

      update("Second");
      expect(container.querySelector("button")).toBe(button);
      expect(button.textContent).toBe("Second: 1");
      expect(document.activeElement).toBe(button);
      expect(disposed).not.toHaveBeenCalled();

      render(nothing, container);
      await Promise.resolve();
      expect(disposed).toHaveBeenCalledOnce();
      expect(button.isConnected).toBe(false);
      render(nothing, container);
      expect(disposed).toHaveBeenCalledOnce();
    } finally {
      render(nothing, container);
      container.remove();
    }
  });

  it("publishes nested mutations and stable getters without replacing the view", () => {
    const state = { text: "First" };
    const props = { state, read: () => state.text };
    function Content(current: typeof props) {
      return (
        <section>
          <p>{current.state.text}</p>
          <output>{current.read()}</output>
        </section>
      );
    }
    const view = mountSolid(() => <div />);
    const container = view.container.querySelector("div")!;
    const paint = () => render(solidContent(Content, props), container);
    try {
      paint();
      const section = container.querySelector("section");
      expect(section?.textContent).toBe("FirstFirst");
      state.text = "Updated";
      paint();
      expect(container.querySelector("section")).toBe(section);
      expect(section?.textContent).toBe("UpdatedUpdated");
    } finally {
      render(nothing, container);
      view.unmount();
    }
  });

  it("preserves an uncommitted input through mutable prop updates and parking", async () => {
    const mounted = vi.fn();
    const disposed = vi.fn();
    function NativeInput(props: { label: string; value: string }) {
      mounted();
      onCleanup(disposed);
      return (
        <label>
          {props.label}
          <textarea value={props.value} />
        </label>
      );
    }
    const view = mountSolid(() => <section />);
    const container = view.container.querySelector("section")!;
    const props = { label: "", value: "" };
    const paint = (label: string) => {
      props.label = label;
      return render(html`${solidContent(NativeInput, props)}`, container);
    };
    const part = paint("First draft");
    try {
      const input = container.querySelector("textarea")!;
      expect(view.getByRole("textbox", { name: "First draft" })).toBe(input);
      input.value = "Unsent text";
      input.focus();
      input.setSelectionRange(3, 7);
      const valueWrites = vi.spyOn(HTMLTextAreaElement.prototype, "value", "set");
      paint("Current draft");
      expect(valueWrites).not.toHaveBeenCalled();
      valueWrites.mockRestore();
      expect(view.getByRole("textbox", { name: "Current draft" })).toBe(input);
      expect(input.value).toBe("Unsent text");
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
      expect(mounted).toHaveBeenCalledOnce();
      expect(disposed).not.toHaveBeenCalled();

      part.setConnected(false);
      await Promise.resolve();
      paint("Updated while parked");
      expect(mounted).toHaveBeenCalledOnce();
      expect(disposed).not.toHaveBeenCalled();
      part.setConnected(true);
      flush();
      expect(view.getByRole("textbox", { name: "Updated while parked" })).toBe(input);
      expect(input.value).toBe("Unsent text");
      expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
      expect(mounted).toHaveBeenCalledOnce();

      render(nothing, container);
      await Promise.resolve();
      expect(disposed).toHaveBeenCalledOnce();
    } finally {
      render(nothing, container);
      view.unmount();
    }
  });

  it("remounts initially unowned Lit content synchronously under its renderer owner", async () => {
    const disposed = vi.fn();
    function Content() {
      onCleanup(disposed);
      return <button type="button">Restored content</button>;
    }
    const container = document.body.appendChild(document.createElement("div"));
    const part = render(html`${solidContent(Content, {})}`, container);
    const original = container.querySelector("button")!;
    container.remove();
    part.setConnected(false);
    await Promise.resolve();
    expect(disposed).toHaveBeenCalledOnce();

    const [connected, setConnected] = createSignal(false);
    const view = mountSolid(() => {
      const owner = getOwner();
      createEffect(connected, (active) => {
        if (active) {
          document.body.append(container);
          // The composer and Lit mount restore their renderer owner for later commits.
          runWithOwner(owner, () => part.setConnected(true));
        }
      });
      return null;
    });
    try {
      setConnected(true);
      expect(() => flush()).not.toThrow();
      const restored = container.querySelector("button")!;
      expect(restored.textContent).toBe("Restored content");
      expect(restored).not.toBe(original);
      expect(disposed).toHaveBeenCalledOnce();

      render(nothing, container);
      await Promise.resolve();
      expect(disposed).toHaveBeenCalledTimes(2);
    } finally {
      render(nothing, container);
      container.remove();
      view.unmount();
    }
  });

  it.each(["replace", "unmount"] as const)(
    "parks nested Solid content and retires it on %s",
    async (removal) => {
      const disposed = vi.fn();
      const disconnected = vi.fn();
      const reconnected = vi.fn();
      class Activity extends AsyncDirective {
        render() {
          return "Activity";
        }

        protected override disconnected() {
          disconnected();
        }

        protected override reconnected() {
          reconnected();
        }
      }
      const activity = directive(Activity);
      function Counter(props: { label: string }) {
        const [count, setCount] = createSignal(0);
        onCleanup(disposed);
        return (
          <>
            <button type="button" onClick={() => setCount((current) => current + 1)}>
              {props.label}: {count()}
            </button>
            <LitContent value={html`<span>${activity()}</span>`} />
          </>
        );
      }
      const [presented, setPresented] = createSignal(true);
      const [label, setLabel] = createSignal("First");
      const [shown, setShown] = createSignal(true);
      const view = mountSolid(() => (
        <SolidContentPresentation value={presented}>
          <LitContent
            value={shown() ? html`${solidContent(Counter, { label: label() })}` : nothing}
          />
        </SolidContentPresentation>
      ));
      flush();
      const button = view.getByRole("button", { name: "First: 0" });
      button.click();
      flush();
      setPresented(false);
      flush();
      await Promise.resolve();
      expect(disposed).not.toHaveBeenCalled();
      expect(disconnected).toHaveBeenCalledOnce();

      setLabel("Second");
      flush();
      setPresented(true);
      flush();
      expect(view.getByRole("button", { name: "Second: 1" })).toBe(button);
      expect(reconnected).toHaveBeenCalledOnce();
      button.focus();
      expect(document.activeElement).toBe(button);

      setPresented(false);
      flush();
      await Promise.resolve();
      if (removal === "replace") {
        setShown(false);
        flush();
      } else {
        view.unmount();
      }
      await Promise.resolve();
      expect(disposed).toHaveBeenCalledOnce();
      expect(button.isConnected).toBe(false);
      view.unmount();
    },
  );
});

it("updates an isolated Lit outlet and retires its directives without replacing Solid siblings", () => {
  const disconnected = vi.fn();
  class ObserveRemoval extends AsyncDirective {
    render(value: string) {
      return value;
    }

    override disconnected() {
      disconnected();
    }
  }
  const observeRemoval = directive(ObserveRemoval);
  const [label, setLabel] = createSignal("First");
  const onClick = vi.fn(() => setLabel("Second"));
  const container = document.createElement("div");
  document.body.append(container);
  const { unmount } = mountSolid(
    () => (
      <section>
        <input aria-label="Solid sibling" />
        <span class="lit-content" style={{ display: "contents" }}>
          <LitContent value={html`<button @click=${onClick}>${observeRemoval(label())}</button>`} />
        </span>
      </section>
    ),
    { container },
  );
  flush();
  const sibling = container.querySelector("input")!;
  const button = container.querySelector("button")!;
  const outlet = button.parentElement!;
  try {
    sibling.value = "Typed value";
    expect(button.textContent).toBe("First");
    button.click();
    flush();
    expect(onClick).toHaveBeenCalledOnce();
    expect(button.textContent).toBe("Second");
    expect(container.querySelector("button")).toBe(button);
    expect(container.querySelector("input")).toBe(sibling);
    expect(sibling.value).toBe("Typed value");
    expect(disconnected).not.toHaveBeenCalled();
  } finally {
    unmount();
  }
  expect(disconnected).toHaveBeenCalledOnce();
  expect(outlet.querySelector("button")).toBeNull();
  expect(container.childNodes).toHaveLength(0);
  setLabel("After disposal");
  flush();
  expect(outlet.textContent).toBe("");
  expect(disconnected).toHaveBeenCalledOnce();
});
