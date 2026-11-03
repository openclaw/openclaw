import { resolveGlobalMap } from "../../shared/global-singleton.js";

// Symbol-backed state survives duplicate module instances during plugin loading.
export const outboundMessageIdentities = resolveGlobalMap<string, number>(
  Symbol.for("openclaw.outboundMessageIdentities"),
);
