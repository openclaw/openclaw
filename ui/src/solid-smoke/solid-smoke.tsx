import type { JSX as SolidJSX } from "@solidjs/web";
import { For, Show, createMemo, createSignal } from "solid-js";
import "../components/option-card.ts";

type OptionCardAttributes = SolidJSX.HTMLAttributes<
  HTMLElementTagNameMap["openclaw-option-card"]
> & {
  "prop:props": HTMLElementTagNameMap["openclaw-option-card"]["props"];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-option-card": OptionCardAttributes;
    }
  }
}

// Deliberately outside the application entry graph: this is a compiler/interop fixture.
export function SolidSmoke() {
  const [count, setCount] = createSignal(0);
  const summary = createMemo(() => `Count: ${count()}`);
  const entries = createMemo(() => Array.from({ length: count() }, (_, index) => index + 1));

  return (
    <section aria-label="Solid smoke">
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Increment
      </button>
      <output>{summary()}</output>
      <Show when={count() > 0} fallback={<p>No entries</p>}>
        <ul>
          <For each={entries()}>{(entry) => <li>Entry {entry}</li>}</For>
        </ul>
      </Show>
      <openclaw-option-card prop:props={{ question: summary(), options: [] }} />
    </section>
  );
}
