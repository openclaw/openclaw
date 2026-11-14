import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import type { BoundKeyRefusal } from "./tunnel-child/keyfile.js";
import type { TunnelSupervisorStatus } from "./tunnel-supervisor.js";

/** What the Control UI and `openclaw status` show for OpenClaw ID. */
export type OpenClawIdStatus =
  | { state: "off" }
  | { state: "unconfigured"; missing: Array<keyof GatewayOpenClawIdConfig> }
  | { state: "on"; tunnel: TunnelSupervisorStatus }
  /**
   * The claw is linked but no key file holds a key its binding names (the endpoint key
   * K_srv or the Gateway key K_gw). Remote access is off and nothing is created or
   * signed with another key; the Gateway keeps running for local use.
   */
  | { state: "keys_refused"; key: "endpoint" | "gateway"; reason: BoundKeyRefusal }
  | { state: "failed"; reason: string };
