import { normalizeStringEntries } from "../../../shared/string-normalization.js";
import type { DoctorAllowFromList } from "../types.js";

export function hasAllowFromEntries(list?: DoctorAllowFromList) {
  return Array.isArray(list) && normalizeStringEntries(list).length > 0;
}
