import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

// Both host module graphs share one owner; its private brand never leaves this closure.
export const { getGatewayContextBindingSlot, prepareGatewayContextBindingOwner } =
  resolveGlobalSingleton(Symbol.for("openclaw.gatewayContextBindingOwner"), () => {
    const gatewayContextBindingOwnerKey = Symbol("gatewayContextBindingOwner");

    class GatewayContextBindingOwner {
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

    function readSlot(owner: object): object | undefined {
      const slot: unknown = Object.getOwnPropertyDescriptor(
        owner,
        gatewayContextBindingOwnerKey,
      )?.value;
      return GatewayContextBindingOwner.read(slot, owner);
    }

    /** Reserve exact-owner storage before admission freezes the public context. */
    function prepareOwner<T extends object>(owner: T): T {
      if (!readSlot(owner)) {
        Object.defineProperty(owner, gatewayContextBindingOwnerKey, {
          value: new GatewayContextBindingOwner(owner),
        });
      }
      return owner;
    }

    return {
      getGatewayContextBindingSlot: readSlot,
      prepareGatewayContextBindingOwner: prepareOwner,
    };
  });
