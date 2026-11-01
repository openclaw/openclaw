import type { DiffStat } from "../../../lib/chat/tool-call-diff.ts";

export function DiffStatChips(props: { stat: DiffStat & { modified?: number } }) {
  const showZeros = () => props.stat.modified === undefined;
  return (
    <>
      {showZeros() || props.stat.added || props.stat.removed || props.stat.modified ? (
        <span class="chat-diffstat">
          {(showZeros() || props.stat.added > 0) && (
            <span class="chat-diffstat__add">+{props.stat.added}</span>
          )}
          {(showZeros() || props.stat.removed > 0) && (
            <span class="chat-diffstat__del">-{props.stat.removed}</span>
          )}
          {(props.stat.modified ?? 0) > 0 && (
            <span class="chat-diffstat__mod">~{props.stat.modified}</span>
          )}
        </span>
      ) : null}
    </>
  );
}
