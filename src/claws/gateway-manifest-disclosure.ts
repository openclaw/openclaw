import type { ClawManifestDisclosure } from "../../packages/gateway-protocol/src/schema/claws.js";
import { parseClawManifest, parseClawOpenClawProfile } from "./schema.js";
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
    !/^@openclaw\/[a-z0-9][a-z0-9._-]*$/u.test(identity.name) ||
    !/^sha256:[a-f0-9]{64}$/u.test(identity.integrity) ||
    !Number.isSafeInteger(identity.byteLength) ||
    identity.byteLength <= 0 ||
    identity.name !== expected.name ||
    identity.version !== expected.version ||
    identity.integrity !== expected.integrity
  ) {
    throw new Error("The Claw source identity cannot be disclosed safely.");
  }

  const manifest = parseClawManifest(source.manifest);
  if (!manifest.ok) {
    throw new Error("The Claw grouped manifest cannot be disclosed safely.");
  }
  const profile = source.openClawProfile
    ? parseClawOpenClawProfile(source.openClawProfile)
    : undefined;
  if (profile && !profile.ok) {
    throw new Error("The Claw OpenClaw profile cannot be disclosed safely.");
  }

  return {
    source: {
      packageName: identity.name,
      version: identity.version,
      integrity: identity.integrity,
      byteLength: identity.byteLength,
    },
    manifestJson: JSON.stringify(manifest.manifest, null, 2),
    ...(profile?.ok ? { openClawProfileJson: JSON.stringify(profile.profile, null, 2) } : {}),
  };
}
