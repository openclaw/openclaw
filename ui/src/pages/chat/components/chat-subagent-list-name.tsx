import { createMemo, Show } from "solid-js";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Shrink the shared prefix before the identifying end of a child name. */
export function SubagentListName(props: { name: string }) {
  const split = createMemo(() => {
    const name = props.name;
    if (name.length <= 16) {
      return undefined;
    }
    const tail = segments.segment(name).containing(name.length - 12)?.index ?? 0;
    const separator = Math.max(
      name.lastIndexOf(" ", tail),
      name.lastIndexOf("-", tail),
      name.lastIndexOf("/", tail),
    );
    const cut = separator >= 0 && separator >= tail - 12 ? separator + 1 : tail;
    return cut > 0 ? { head: name.slice(0, cut), tail: name.slice(cut) } : undefined;
  });
  return (
    <Show when={split()} fallback={props.name}>
      {(parts) => (
        <span class="subagent-list-name" title={props.name}>
          <span class="subagent-list-name__head">{parts().head}</span>
          <span class="subagent-list-name__tail">{parts().tail}</span>
        </span>
      )}
    </Show>
  );
}
