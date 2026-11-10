import type { JSX } from "@solidjs/web";

export function renderSlashMatchedName(name: string, query: string): JSX.Element {
  const matchLength = name.toLowerCase().startsWith(query.toLowerCase()) ? query.length : 0;
  return matchLength === 0 ? (
    <>{name}</>
  ) : (
    <>
      <mark>{name.slice(0, matchLength)}</mark>
      {name.slice(matchLength)}
    </>
  );
}
