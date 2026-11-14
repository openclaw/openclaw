import type { TemplateManifestDisclosure } from "../../packages/gateway-protocol/src/schema/templates.js";
import { isCanonicalClawHubPackageName } from "./schema-portability.js";
import type { TemplateReadResult, TemplateSourceIdentity } from "./types.js";

type VerifiedTemplateSource = Extract<TemplateReadResult, { ok: true }>;

export function projectTemplateManifestDisclosure(
  source: VerifiedTemplateSource,
  expected: Pick<TemplateSourceIdentity, "name" | "version" | "integrity">,
): TemplateManifestDisclosure {
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
    throw new Error("The Template source identity cannot be disclosed safely.");
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
