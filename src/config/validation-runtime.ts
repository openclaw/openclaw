// Callers supply declared schema property owners, excluding record keys and indices.
// Authority and isolation containers require their owners to migrate unknown restrictions.
export function isRuntimeConfigUnknownPath(path: readonly (string | number)[]): boolean {
  return !path.some(
    (segment) =>
      typeof segment === "string" &&
      [
        "auth",
        "secrets",
        "security",
        "accessGroups",
        "approvals",
        "sandbox",
        "modelPolicy",
        "permissions",
        "roles",
      ].includes(segment),
  );
}

/** Omit schema-rejected paths only from an isolated runtime candidate. */
export function omitRuntimeConfigPaths(
  value: unknown,
  paths: ReadonlyArray<ReadonlyArray<string | number>>,
): unknown {
  const candidate: unknown = structuredClone(value);
  for (const path of paths) {
    let parent = candidate;
    for (const segment of path.slice(0, -1)) {
      if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, segment)) {
        parent = undefined;
        break;
      }
      parent = Reflect.get(parent, segment);
    }
    const key = path.at(-1);
    if (key !== undefined && parent !== null && typeof parent === "object") {
      Reflect.deleteProperty(parent, key);
    }
  }
  return candidate;
}
