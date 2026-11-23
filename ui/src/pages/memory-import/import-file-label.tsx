import { createMemo, Show } from "solid-js";

export function ImportFileLabel(props: { path: string; source?: string | null }) {
  const slash = createMemo(() =>
    Math.max(props.path.lastIndexOf("/"), props.path.lastIndexOf("\\")),
  );
  return (
    <code class="memory-import__file-label" title={props.source ?? props.path}>
      <Show when={slash() >= 0}>
        <span class="memory-import__folder">
          <bdi>{props.path.slice(0, slash() + 1)}</bdi>
        </span>
      </Show>
      <span class="memory-import__filename">
        <bdi>{props.path.slice(slash() + 1)}</bdi>
      </span>
    </code>
  );
}
