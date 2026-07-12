// Gateway connection role policy.
// Separates node-role RPCs from operator RPCs before method scope checks.
import { isNodeRoleMethod } from "./method-scopes.js";
import { isCoreGatewayMethodClassified } from "./methods/core-descriptors.js";

const GATEWAY_ROLES = ["operator", "node", "member"] as const;

type GatewayAccessMarker = Readonly<{ kind: string; member?: boolean }>;

/** Gateway connection roles used before method-level operator scope checks. */
export type GatewayRole = (typeof GATEWAY_ROLES)[number];

/** Parses the untrusted role claim from connect params into the closed role set. */
export function parseGatewayRole(roleRaw: unknown): GatewayRole | null {
  if (roleRaw === "operator" || roleRaw === "node" || roleRaw === "member") {
    return roleRaw;
  }
  return null;
}

/** Operators using shared auth may connect before device identity is established. */
export function roleCanSkipDeviceIdentity(role: GatewayRole, sharedAuthOk: boolean): boolean {
  return role === "operator" && sharedAuthOk;
}

/** Keeps node-originated notifications off the operator RPC surface, and vice versa. */
export function isRoleAuthorizedForMethod(
  role: GatewayRole,
  method: string,
  access?: GatewayAccessMarker,
): boolean {
  if (isNodeRoleMethod(method)) {
    return role === "node";
  }
  if (role === "member") {
    return (
      access?.kind === "resource" &&
      access.member === true &&
      !isCoreGatewayMethodClassified(method)
    );
  }
  return role === "operator";
}

/** Removes every broad/core method from the capability list advertised to member clients. */
export function filterAdvertisedGatewayMethodsForRole(
  role: GatewayRole,
  methods: readonly string[],
  getAccessPolicy: (method: string) => GatewayAccessMarker | undefined,
): string[] {
  if (role !== "member") {
    return [...methods];
  }
  return methods.filter((method) =>
    isRoleAuthorizedForMethod(role, method, getAccessPolicy(method)),
  );
}
