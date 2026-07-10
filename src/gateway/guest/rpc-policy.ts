/** Guest-local methods are handled without entering the operator dispatcher. */
export const GUEST_RPC_ALLOWLIST: ReadonlySet<string> = new Set(["guest.token.refresh"]);
