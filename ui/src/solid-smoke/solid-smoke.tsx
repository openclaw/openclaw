import { For, Show, createMemo, createSignal } from "solid-js";
import { OptionCard } from "../components/option-card.tsx";

// Deliberately outside the application entry graph: this is a compiler fixture.
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
      <OptionCard props={{ question: summary(), options: [] }} />
    </section>
  );
}
