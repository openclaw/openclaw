import { z } from "zod";

/** Visit schema wrappers and their fields in config path order, preserving array/wildcard paths. */
export function walkConfigSchema(
  schema: z.ZodType,
  path: string,
  visit: (schema: z.ZodType, path: string) => void,
): void {
  const walk = (node: z.core.$ZodType, fieldPath: string): void => {
    let current = node;
    while (true) {
      // SAFETY: Config trees use classic Zod; its child generics expose only the core type.
      visit(current as z.ZodType, fieldPath);
      if (!isUnwrappable(current)) {
        break;
      }
      current = current.unwrap();
    }

    if (current instanceof z.ZodPipe) {
      // Config projections follow parsed output, including preprocess pipelines.
      walk(current.out, fieldPath);
    } else if (current instanceof z.ZodObject) {
      for (const key in current.shape) {
        walk(current.shape[key], fieldPath ? `${fieldPath}.${key}` : key);
      }
      const catchall = current.def.catchall;
      if (catchall && !(catchall instanceof z.ZodNever)) {
        walk(catchall, fieldPath ? `${fieldPath}.*` : "*");
      }
    } else if (current instanceof z.ZodArray) {
      walk(current.element, fieldPath ? `${fieldPath}[]` : "[]");
    } else if (current instanceof z.ZodRecord) {
      walk(current.def.valueType, fieldPath ? `${fieldPath}.*` : "*");
    } else if (current instanceof z.ZodUnion) {
      for (const option of current.options) {
        walk(option, fieldPath);
      }
    } else if (current instanceof z.ZodIntersection) {
      walk(current.def.left, fieldPath);
      walk(current.def.right, fieldPath);
    }
  };
  walk(schema, path);
}

/** Resolve declared property owners without treating record keys or array indices as fields. */
export function resolveConfigSchemaStructuralPath(
  schema: z.ZodType,
  path: readonly PropertyKey[],
): string[] | undefined {
  let current: z.core.$ZodType = schema;
  const structuralPath: string[] = [];
  let index = 0;
  for (;;) {
    if (isUnwrappable(current)) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodPipe) {
      current = current.out;
      continue;
    }
    if (index === path.length) {
      return current instanceof z.ZodObject ? structuralPath : undefined;
    }
    const segment = path[index++];
    if (current instanceof z.ZodObject) {
      if (typeof segment === "string" && Object.hasOwn(current.shape, segment)) {
        structuralPath.push(segment);
        current = current.shape[segment];
      } else if (current.def.catchall && !(current.def.catchall instanceof z.ZodNever)) {
        current = current.def.catchall;
      } else {
        return undefined;
      }
    } else if (current instanceof z.ZodRecord) {
      current = current.def.valueType;
    } else if (current instanceof z.ZodArray && typeof segment === "number") {
      current = current.element;
    } else {
      // A validator issue alone cannot identify the selected union/intersection branch.
      return undefined;
    }
  }
}

function isUnwrappable(
  schema: z.core.$ZodType,
): schema is z.core.$ZodType & { unwrap: () => z.core.$ZodType } {
  // Arrays also expose unwrap(), but introduce a path segment before visiting their element.
  return (
    "unwrap" in schema && typeof schema.unwrap === "function" && !(schema instanceof z.ZodArray)
  );
}
