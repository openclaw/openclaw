export function* workspacePathAncestors(entryPath: string): Generator<string> {
  for (
    let separator = entryPath.indexOf("/");
    separator >= 0;
    separator = entryPath.indexOf("/", separator + 1)
  ) {
    yield entryPath.slice(0, separator);
  }
}
