/** One line that keeps its end: the start gives way when the value does not fit. */
export function MiddleTruncated(props: { head: string; tail: string }) {
  return (
    <span class="plugin-metadata__middle" title={`${props.head}${props.tail}`}>
      <span>{props.head}</span>
      <span>{props.tail}</span>
    </span>
  );
}

/** Splits a path or URL before its last `segments` slash-separated parts. */
export function splitTail(value: string, segments = 1): { head: string; tail: string } {
  let cut = value.length - 1;
  for (let index = 0; index < segments && cut > 0; index++) {
    cut = value.lastIndexOf("/", cut - 1);
  }
  return cut > 0
    ? { head: value.slice(0, cut + 1), tail: value.slice(cut + 1) }
    : { head: "", tail: value };
}
