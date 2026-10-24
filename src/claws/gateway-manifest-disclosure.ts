import type { ClawManifestDisclosure } from "../../packages/gateway-protocol/src/schema/claws.js";
import { isCanonicalClawHubPackageName } from "./schema-portability.js";
import type { ClawReadResult, ClawSourceIdentity } from "./types.js";

type VerifiedClawSource = Extract<ClawReadResult, { ok: true }>;

export function projectClawManifestDisclosure(
  source: VerifiedClawSource,
  expected: Pick<ClawSourceIdentity, "name" | "version" | "integrity">,
): ClawManifestDisclosure {
  const identity = source.source;
  if (
    identity.kind !== "package" ||
    identity.integrityKind !== "artifact" ||
    !isCanonicalClawHubPackageName(identity.name) ||
    !/^sha256:[a-f0-9]{64}$/u.test(identity.integrity) ||
    !Number.isSafeInteger(identity.byteLength) ||
    identity.byteLength <= 0 ||
    identity.name !== expected.name ||
    identity.version !== expected.version ||
    identity.integrity !== expected.integrity
  ) {
    throw new Error("The Claw source identity cannot be disclosed safely.");
  }

  return {
    source: {
      packageName: identity.name,
      version: identity.version,
      integrity: identity.integrity,
      byteLength: identity.byteLength,
    },
    manifestJson: JSON.stringify(source.manifest, null, 2),
    ...(source.openClawProfile
      ? { openClawProfileJson: JSON.stringify(source.openClawProfile, null, 2) }
      : {}),
  };
}
