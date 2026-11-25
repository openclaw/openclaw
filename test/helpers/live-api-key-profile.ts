import type { ModelsAuthSetApiKeyResult } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { OpenClawTestInstance } from "./openclaw-test-instance.js";

/** Persist through the same Gateway owner as `models auth`, without keys in CLI arguments. */
export async function storeLiveApiKeyProfile(
  instance: Pick<OpenClawTestInstance, "url" | "gatewayToken">,
  params: { provider: string; apiKey: string | undefined; agentId: string },
): Promise<string> {
  if (!params.apiKey?.trim()) {
    throw new Error("A live API key is required to store the test inference account.");
  }
  const { callGateway } = await import("../../src/gateway/call.js");
  const result = await callGateway<ModelsAuthSetApiKeyResult>({
    url: instance.url,
    token: instance.gatewayToken,
    config: { gateway: { mode: "local", auth: { mode: "token", token: instance.gatewayToken } } },
    deviceIdentity: null,
    sharedStateMode: "read-only",
    skipImplicitAuth: true,
    scopes: ["operator.admin"],
    method: "models.authSetApiKey",
    params,
    timeoutMs: 60_000,
  });
  if (result.warning) {
    throw new Error(result.warning);
  }
  return result.profileId;
}
