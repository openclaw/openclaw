export function cloneConfigObject<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function serializeConfigForm(form: Record<string, unknown>): string {
  return `${JSON.stringify(form, null, 2).trimEnd()}\n`;
}

export function setPathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
  value: unknown,
) {
<<<<<<< HEAD
  if (path.length === 0) return;
=======
  if (path.length === 0) {
    return;
  }
>>>>>>> upstream/main
  let current: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const nextKey = path[i + 1];
    if (typeof key === "number") {
<<<<<<< HEAD
      if (!Array.isArray(current)) return;
=======
      if (!Array.isArray(current)) {
        return;
      }
>>>>>>> upstream/main
      if (current[key] == null) {
        current[key] = typeof nextKey === "number" ? [] : ({} as Record<string, unknown>);
      }
      current = current[key] as Record<string, unknown> | unknown[];
    } else {
<<<<<<< HEAD
      if (typeof current !== "object" || current == null) return;
=======
      if (typeof current !== "object" || current == null) {
        return;
      }
>>>>>>> upstream/main
      const record = current as Record<string, unknown>;
      if (record[key] == null) {
        record[key] = typeof nextKey === "number" ? [] : ({} as Record<string, unknown>);
      }
      current = record[key] as Record<string, unknown> | unknown[];
    }
  }
  const lastKey = path[path.length - 1];
  if (typeof lastKey === "number") {
<<<<<<< HEAD
    if (Array.isArray(current)) current[lastKey] = value;
=======
    if (Array.isArray(current)) {
      current[lastKey] = value;
    }
>>>>>>> upstream/main
    return;
  }
  if (typeof current === "object" && current != null) {
    (current as Record<string, unknown>)[lastKey] = value;
  }
}

export function removePathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
) {
<<<<<<< HEAD
  if (path.length === 0) return;
=======
  if (path.length === 0) {
    return;
  }
>>>>>>> upstream/main
  let current: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (typeof key === "number") {
<<<<<<< HEAD
      if (!Array.isArray(current)) return;
      current = current[key] as Record<string, unknown> | unknown[];
    } else {
      if (typeof current !== "object" || current == null) return;
      current = (current as Record<string, unknown>)[key] as Record<string, unknown> | unknown[];
    }
    if (current == null) return;
  }
  const lastKey = path[path.length - 1];
  if (typeof lastKey === "number") {
    if (Array.isArray(current)) current.splice(lastKey, 1);
=======
      if (!Array.isArray(current)) {
        return;
      }
      current = current[key] as Record<string, unknown> | unknown[];
    } else {
      if (typeof current !== "object" || current == null) {
        return;
      }
      current = (current as Record<string, unknown>)[key] as Record<string, unknown> | unknown[];
    }
    if (current == null) {
      return;
    }
  }
  const lastKey = path[path.length - 1];
  if (typeof lastKey === "number") {
    if (Array.isArray(current)) {
      current.splice(lastKey, 1);
    }
>>>>>>> upstream/main
    return;
  }
  if (typeof current === "object" && current != null) {
    delete (current as Record<string, unknown>)[lastKey];
  }
}
