import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { throwExpectedCliError } from "./expected-cli-error.js";

export function parseKeyValueEntries(
  values: readonly string[] | undefined,
  label: string,
  fail = throwExpectedCliError,
): Record<string, string> | undefined {
  const entries: Record<string, string> = {};
  for (const raw of values ?? []) {
    const separatorIndex = raw.indexOf("=");
    if (separatorIndex <= 0) {
      fail(`${label} entries must use KEY=VALUE.`);
    }
    const key = raw.slice(0, separatorIndex).trim();
    if (!key) {
      fail(`${label} entries must use a non-empty key.`);
    }
    if (isBlockedObjectKey(key)) {
      fail(`${label} key "${key}" is reserved; use a different key name.`);
    }
    entries[key] = raw.slice(separatorIndex + 1);
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}
