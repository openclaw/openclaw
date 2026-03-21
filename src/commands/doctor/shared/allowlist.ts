import type { DoctorAllowFromList } from "../types.js";

export function hasAllowFromEntries(list?: DoctorAllowFromList) {
  return Array.isArray(list) && list.map((v) => String(v).trim()).filter(Boolean).length > 0;
}
