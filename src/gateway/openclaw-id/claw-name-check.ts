// Make reachable's claw name check: which address Discovery assigns the link code's
// account for a claw name ("<name>-<account tag>.<loader domain>") and whether it is
// free. Signed with K_gw, and only for the operator on this machine.
import type { Channel } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import { isOpenClawIdEnabled } from "../../shared/openclaw-id-policy.js";
import type { AuthorityRefusal } from "./authority-result.js";
import type { createServiceGatewayKey } from "./service-gateway-key.js";

/** The owner's choice for "Make reachable": a one-time link code and a claw name. */
export type ClawNameRequest = { enrollmentCode?: string; name?: string };

/** The address Discovery assigns for a claw name, and whether it is free. */
export type ClawNameCheck = {
  name: string;
  accountTag: string;
  hostname: string;
  available: boolean;
};

const refusal = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });

/** Asks Discovery about a claw name; `signal` is the remote-access lifetime it runs in. */
export async function checkClawName(params: {
  channel: Channel | undefined;
  request: ClawNameRequest;
  config: GatewayOpenClawIdConfig | undefined;
  signal: AbortSignal;
  gatewayKey: ReturnType<typeof createServiceGatewayKey>;
}): Promise<ClawNameCheck | AuthorityRefusal> {
  const { channel, request, config, signal } = params;
  if (channel !== "local_operator") {
    return refusal("not_local_operator", "Make reachable only works on this machine");
  }
  if (!isOpenClawIdEnabled(config) || !config?.loaderDomain || !config.discoveryUrl) {
    return refusal("unconfigured", "set gateway.openclawId.loaderDomain and discoveryUrl first");
  }
  if (!request.enrollmentCode || !request.name) {
    return refusal("malformed", "a link code and a claw name are required");
  }
  const { createDiscoveryClient } = await import("./discovery-client.js");
  const key = await params.gatewayKey.tryLoad();
  if (!key.ok) {
    return refusal(key.refused.reason, key.refused.message);
  }
  if (signal.aborted) {
    return refusal("off", "remote access was turned off");
  }
  const client = createDiscoveryClient({
    baseUrl: config.discoveryUrl,
    signer: key.signer,
    signal,
  });
  try {
    const checked = await client.checkClawName(request.enrollmentCode, request.name);
    // The binding is only usable on a single label under the loader domain.
    if (checked.hostname !== `${checked.name}-${checked.account_tag}.${config.loaderDomain}`) {
      return refusal("wrong_domain", `Discovery offered ${checked.hostname}`);
    }
    return {
      name: checked.name,
      accountTag: checked.account_tag,
      hostname: checked.hostname,
      available: checked.available,
    };
  } catch (error) {
    // SAFETY: code is optional and falls back to "unavailable" when absent.
    const code = (error as { code?: string }).code ?? "unavailable";
    return refusal(code, error instanceof Error ? error.message : String(error));
  }
}
