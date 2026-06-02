import type { OperatorScope } from "../operator-scopes.js";

/** Scope marker for methods that only authenticated node clients may call. */
export const NODE_GATEWAY_METHOD_SCOPE = "node" as const;
/** Scope marker for methods whose handler derives the required operator scope at runtime. */
export const DYNAMIC_GATEWAY_METHOD_SCOPE = "dynamic" as const;

/** Authorization scope attached to a gateway method descriptor. */
export type GatewayMethodScope =
  | OperatorScope
  | typeof NODE_GATEWAY_METHOD_SCOPE
  | typeof DYNAMIC_GATEWAY_METHOD_SCOPE;

/** Owner metadata used to keep core, plugin, channel, and auxiliary methods distinguishable. */
export type GatewayMethodOwner =
  | { kind: "core"; area: string }
  | { kind: "plugin"; pluginId: string }
  | { kind: "channel"; channelId: string }
  | { kind: "aux"; area: string };

/** Startup availability flag exposed to clients as retryable startup-unavailable errors. */
export type GatewayMethodStartupAvailability = "available" | "unavailable-until-sidecars";

export type GatewayMethodHandler = (opts: never) => unknown;

/** Complete metadata for one dispatchable gateway method. */
export type GatewayMethodDescriptor = {
  /** Normalized JSON-RPC method name used for dispatch and advertisement. */
  name: string;
  /** Handler invoked after auth, startup, and rate-limit gates pass. */
  handler: GatewayMethodHandler;
  /** Required caller scope, node-only marker, or dynamic runtime authorization marker. */
  scope: GatewayMethodScope;
  /** Owning subsystem used for diagnostics, policy, and duplicate detection. */
  owner: GatewayMethodOwner;
  /** Startup gate that lets clients retry methods depending on sidecar readiness. */
  startup?: GatewayMethodStartupAvailability;
  /** Marks methods that mutate control-plane state and consume write budget. */
  controlPlaneWrite?: boolean;
  /** Whether this method should appear in client-facing method listings. */
  advertise?: boolean;
  /** Optional human-readable method description for diagnostics and discovery. */
  description?: string;
};

/** Input descriptor shape before registry normalization trims and validates the method name. */
export type GatewayMethodDescriptorInput = Omit<GatewayMethodDescriptor, "name"> & {
  name: string;
};

/** Read-only method registry view used by request dispatch and method listing. */
export type GatewayMethodRegistryView = {
  /** Resolve the dispatch handler for an exact normalized method name. */
  getHandler: (name: string) => GatewayMethodHandler | undefined;
  /** List all registered method names, including hidden/internal methods. */
  listMethods: () => string[];
  /** List only methods explicitly advertised to clients. */
  listAdvertisedMethods: () => string[];
  /** Resolve the authorization scope for an exact method name. */
  getScope: (name: string) => GatewayMethodScope | undefined;
  /** Return true when a method exists but is gated on sidecar startup. */
  isStartupUnavailable: (name: string) => boolean;
  /** Return true when a method consumes the control-plane write budget. */
  isControlPlaneWrite: (name: string) => boolean;
  /** Return immutable descriptors for registry inspection and diagnostics. */
  descriptors: () => readonly GatewayMethodDescriptor[];
};
