import { createMemo, Show } from "solid-js";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Let ordinary names wrap. For unusually long names, clamp the middle, not the identifying end. */
export function SubagentListName(props: { name: string }) {
  const split = createMemo(() => {
    const name = props.name;
    if (name.length <= 128) return undefined;
    const tail = segments.segment(name).containing(name.length - 28)?.index ?? 0;
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
        <>
          <span class="subagent-list-name__head">{parts().head}</span>
          {parts().tail}
        </>
      )}
    </Show>
  );
}
