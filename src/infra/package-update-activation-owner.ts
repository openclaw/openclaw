// Compatibility entry for the executor-owned native publisher. Prepared-owner
// dispatch stays registered by the activation coordinator; no second registry.
export { createPackageActivationForwardProvider as createPublicationOwner } from "./package-update-activation.js";
