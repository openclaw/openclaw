import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

export type DoctorSessionRouteStateOwner = {
  id: string;
  label: string;
  providerIds?: readonly string[];
  runtimeIds?: readonly string[];
  cliSessionKeys?: readonly string[];
  authProfilePrefixes?: readonly string[];
};

export function coerceDoctorSessionRouteStateOwners(
  value: unknown,
): DoctorSessionRouteStateOwner[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const candidate = asOptionalObjectRecord(entry);
    if (typeof candidate?.id !== "string" || typeof candidate.label !== "string") {
      return [];
    }
    const id = candidate.id.trim();
    const label = candidate.label.trim();
    if (!id || !label) {
      return [];
    }
    const owner = {
      id,
      label,
      providerIds: normalizeTrimmedStringList(candidate.providerIds),
      runtimeIds: normalizeTrimmedStringList(candidate.runtimeIds),
      cliSessionKeys: normalizeTrimmedStringList(candidate.cliSessionKeys),
      authProfilePrefixes: normalizeTrimmedStringList(candidate.authProfilePrefixes),
    };
    return (["providerIds", "runtimeIds", "cliSessionKeys", "authProfilePrefixes"] as const).every(
      (key) => candidate[key] === undefined || owner[key].length > 0,
    )
      ? [owner]
      : [];
  });
}
