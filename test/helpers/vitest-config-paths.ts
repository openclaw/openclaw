import path from "node:path";

export function normalizeConfigPath(value: unknown): unknown {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    return value;
  }
  return path.relative(process.cwd(), value).split(path.sep).join("/");
}

export function normalizeConfigPaths(
  values: readonly unknown[] | string | undefined,
): unknown[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (!Array.isArray(values)) {
    return [normalizeConfigPath(values)];
  }
  return values.map((value) => normalizeConfigPath(value));
}
