/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { Show, createMemo, createSignal, onCleanup } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { LitContent as LegacyOutlet } from "./solid-bridge.ts";
import {
  LitContent,
  mountLitContent,
  solidContent,
  SolidContentPresentation,
} from "./solid-content.tsx";

describe("Lit and Solid content boundaries", () => {
  it("updates a retained media mount and clears its range before remounting", () => {
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
    let mounted = mountLitContent(content("First"), container);
    try {
      const button = container.querySelector("button")!;
      mounted = mountLitContent(content("Second"), container);
      expect(container.querySelector("button")).toBe(button);
      expect(button.textContent).toBe("Second");
      expect(disconnected).not.toHaveBeenCalled();

      mounted.dispose();
      mounted.dispose();
      expect(container.childNodes).toHaveLength(0);
      expect(disconnected).toHaveBeenCalledOnce();

      mounted = mountLitContent(content("Third"), container);
      expect(container.querySelector("button")?.textContent).toBe("Third");
      expect(container.querySelector("button")).not.toBe(button);
      mounted.dispose();
      expect(container.childNodes).toHaveLength(0);
      expect(disconnected).toHaveBeenCalledTimes(2);
    } finally {
      mounted.dispose();
      container.remove();
    }
  });

  it("keeps Lit markup as direct children, updates it, and disconnects nested directives", () => {
    const disconnected = vi.fn();
    class TrackedContent extends AsyncDirective {
      render(value: string) {
        return value;
      }

      protected override disconnected() {
        disconnected();
      }
    }
    const tracked = directive(TrackedContent);
    const content = (label: string) =>
      html`<button>${tracked(label)}</button>
        <p>Details</p>`;
    const [value, setValue] = createSignal(content("First"));
    const [shown, setShown] = createSignal(true);
    const view = mountSolid(() => (
      <section>
        <Show when={shown()}>
          <LitContent value={value()} />
        </Show>
        <footer>Retained sibling</footer>
      </section>
    ));
    flush();
    const section = view.container.querySelector("section")!;
    const button = view.getByRole("button", { name: "First" });
    const footer = section.querySelector("footer");
    expect([...section.children].map((element) => element.tagName)).toEqual([
      "BUTTON",
      "P",
      "FOOTER",
    ]);
    expect(button.parentElement).toBe(section);

    setValue(content("Second"));
    flush();
    expect(view.getByRole("button", { name: "Second" })).toBe(button);
    expect(section.querySelector("footer")).toBe(footer);
    expect(disconnected).not.toHaveBeenCalled();

    setShown(false);
    flush();
    expect([...section.children]).toEqual([footer]);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(button.isConnected).toBe(false);
    view.unmount();
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it("adopts eagerly created Lit content after its Solid branch becomes visible", () => {
    const [shown, setShown] = createSignal(false);
    const disconnected = vi.fn();
    class DelayedContent extends AsyncDirective {
      render() {
        return "Delayed action";
      }

      protected override disconnected() {
        disconnected();
      }
    }
    const delayed = directive(DelayedContent);
    const view = mountSolid(() => {
      const content = <LitContent value={html`<button>${delayed()}</button>`} />;
      return (
        <section>
          <Show when={shown()}>{content}</Show>
          <footer>Retained sibling</footer>
        </section>
      );
    });
    flush();
    expect(view.queryByRole("button")).toBeNull();

    setShown(true);
    flush();
    const section = view.container.querySelector("section")!;
    const button = view.getByRole("button", { name: "Delayed action" });
    expect(button.parentElement).toBe(section);
    expect([...section.children].map((element) => element.tagName)).toEqual(["BUTTON", "FOOTER"]);
    expect(disconnected).not.toHaveBeenCalled();

    view.unmount();
    expect(button.isConnected).toBe(false);
    expect(disconnected).toHaveBeenCalledOnce();
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

  it("mounts and reconnects Solid content introduced by a Lit content effect", async () => {
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
    const [value, setValue] = createSignal<unknown>(nothing);
    const [presented, setPresented] = createSignal(true);
    const content = (label: string) => html`${solidContent(Counter, { label })}`;
    const view = mountSolid(() => (
      <SolidContentPresentation value={presented}>
        <LitContent value={value()} />
      </SolidContentPresentation>
    ));

    setValue(content("First"));
    flush();
    const button = view.getByRole("button", { name: "First: 0" });
    button.click();
    flush();
    setValue(content("Second"));
    flush();
    expect(view.getByRole("button", { name: "Second: 1" })).toBe(button);

    setPresented(false);
    flush();
    await Promise.resolve();
    expect(disposed).not.toHaveBeenCalled();
    setPresented(true);
    flush();
    expect(view.getByRole("button", { name: "Second: 1" })).toBe(button);
    view.unmount();
    await Promise.resolve();
    expect(disposed).toHaveBeenCalledOnce();
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
        <LegacyOutlet
          render={() => html`<button @click=${onClick}>${observeRemoval(label())}</button>`}
        />
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
