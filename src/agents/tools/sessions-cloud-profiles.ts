import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { EnvironmentsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { jsonResult, readToolStringParam, ToolInputError } from "./common.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

export async function listSessionCloudProfiles(
  params: Record<string, unknown>,
  request: AgentToolGatewayRequestCaller,
) {
  const catalog = await request<EnvironmentsListResult>({
    method: "environments.list",
    params: { projection: "profiles" },
  });
  const profiles = catalog.profiles ?? [];
  const profileId = normalizeOptionalString(readToolStringParam(params, "profileId"));
  if (profileId) {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    return jsonResult(
      profile
        ? { profile }
        : { status: "error", error: "Cloud profile is not configured", profileId },
    );
  }
  const offset = params.offset ?? 0;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new ToolInputError("cloud_profiles offset must be a non-negative integer");
  }
  const page = profiles
    .slice(offset, offset + 32)
    .map(({ id, providerId, trust, executionModes }) => ({
      id,
      providerId,
      trust,
      executionModes,
    }));
  return jsonResult({
    profiles: page,
    ...(offset + page.length < profiles.length ? { nextOffset: offset + page.length } : {}),
  });
}
