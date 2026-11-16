import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

// Source-transformed plugins and native chunks must recognize the same private owner brand.
const { gatewayContextBindingOwnerKey, GatewayContextBindingOwner } = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayContextBindingOwner"),
  () => {
    class BindingOwner {
      readonly #owner: object;

      constructor(owner: object) {
        this.#owner = owner;
        Object.setPrototypeOf(this, null);
      }

      static read(value: unknown, owner: object): object | undefined {
        return typeof value === "object" &&
          value !== null &&
          #owner in value &&
          value.#owner === owner
          ? value
          : undefined;
      }
    }
    return {
      gatewayContextBindingOwnerKey: Symbol("gatewayContextBindingOwner"),
      GatewayContextBindingOwner: BindingOwner,
    };
  },
);

export function getGatewayContextBindingSlot(owner: object): object | undefined {
  const slot: unknown = Object.getOwnPropertyDescriptor(
    owner,
    gatewayContextBindingOwnerKey,
  )?.value;
  return GatewayContextBindingOwner.read(slot, owner);
}

/** Reserve exact-owner storage before admission freezes the public context. */
export function prepareGatewayContextBindingOwner<T extends object>(owner: T): T {
  if (!getGatewayContextBindingSlot(owner)) {
    Object.defineProperty(owner, gatewayContextBindingOwnerKey, {
      value: new GatewayContextBindingOwner(owner),
    });
  }
  return owner;
}
