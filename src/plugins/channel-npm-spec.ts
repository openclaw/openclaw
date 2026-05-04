import { isPrereleaseSemverVersion, parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export function resolveChannelAwareNpmSpec(params: {
  npmSpec?: string;
  packageName?: string;
  packageVersion?: string;
  channel?: UpdateChannel;
}): string | undefined {
  const npmSpec =
    normalizeOptionalString(params.npmSpec) ?? normalizeOptionalString(params.packageName);
  if (!npmSpec) {
    return undefined;
  }
  const parsed = parseRegistryNpmSpec(npmSpec);
  if (!parsed || parsed.selectorKind !== "none") {
    return npmSpec;
  }
  const packageName = normalizeOptionalString(params.packageName);
  const expectedName = packageName
    ? (parseRegistryNpmSpec(packageName)?.name ?? packageName)
    : undefined;
  if (expectedName && parsed.name !== expectedName) {
    return npmSpec;
  }
  const packageVersion = normalizeOptionalString(params.packageVersion);
  if (packageVersion && isPrereleaseSemverVersion(packageVersion)) {
    return `${parsed.name}@${packageVersion}`;
  }
  if (params.channel === "beta") {
    return `${parsed.name}@beta`;
  }
  return npmSpec;
}
