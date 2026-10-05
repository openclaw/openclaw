import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import type { UpdateDoctorConfigChange } from "./update-doctor-config-format.js";

/** Shipped Doctors without typed receipts expose only their private config write window. */
export async function observeUpdateDoctorConfigChanges(
  configPath: string,
  before: unknown,
  recorded?: UpdateDoctorConfigChange[],
): Promise<UpdateDoctorConfigChange[]> {
  if (recorded) {
    return recorded;
  }
  if (!isRecord(before)) {
    return [];
  }
  const after: unknown = JSON5.parse(await fs.readFile(configPath, "utf8"));
  if (!isRecord(after)) {
    return [];
  }
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !isDeepStrictEqual(before[key], after[key]))
    .toSorted()
    .map((key) => ({ kind: "key", key }));
}
