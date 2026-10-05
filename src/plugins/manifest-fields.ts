/** Only fresh field projections belong here; never mutate the authored manifest. */
export function omitUndefinedManifestFields<T extends object>(fields: T): T {
  for (const key in fields) {
    if (fields[key] === undefined) {
      delete fields[key];
    }
  }
  return fields;
}

export function optionalManifestFields<T extends object>(fields: T): T | undefined {
  omitUndefinedManifestFields(fields);
  return Object.keys(fields).length > 0 ? fields : undefined;
}
