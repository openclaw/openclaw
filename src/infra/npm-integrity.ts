import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NpmIntegrityDrift, NpmSpecResolution } from "./install-source-utils.js";

export type NpmIntegrityDriftPayload = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
};

type ResolveNpmIntegrityDriftWithDefaultMessageParams = {
  spec: string;
  expectedIntegrity?: string;
  resolution: NpmSpecResolution;
  onIntegrityDrift?: (payload: NpmIntegrityDriftPayload) => boolean | Promise<boolean>;
  warn?: (message: string) => void;
};

export async function resolveNpmIntegrityDriftWithDefaultMessage(
  params: ResolveNpmIntegrityDriftWithDefaultMessageParams,
): Promise<{ integrityDrift?: NpmIntegrityDrift; error?: string }> {
  const expectedIntegrity = normalizeOptionalString(params.expectedIntegrity);
  if (!expectedIntegrity) {
    return {};
  }

  const subject = params.resolution.resolvedSpec ?? params.spec;
  const actualIntegrity = normalizeOptionalString(params.resolution.integrity);
  if (!actualIntegrity) {
    return { error: `aborted: npm package integrity missing for ${subject}` };
  }
  if (expectedIntegrity === actualIntegrity) {
    return {};
  }

  const integrityDrift: NpmIntegrityDrift = { expectedIntegrity, actualIntegrity };
  const payload: NpmIntegrityDriftPayload = {
    spec: params.spec,
    expectedIntegrity,
    actualIntegrity,
    resolution: params.resolution,
  };
  let proceed = false;
  if (params.onIntegrityDrift) {
    proceed = await params.onIntegrityDrift(payload);
  } else {
    params.warn?.(
      `Integrity drift detected for ${subject}: expected ${expectedIntegrity}, got ${actualIntegrity}`,
    );
  }

  return {
    integrityDrift,
    ...(proceed ? {} : { error: `aborted: npm package integrity drift detected for ${subject}` }),
  };
}
