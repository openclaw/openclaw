// Delivery context helpers normalize target and route metadata for delivery.
export {
  deliveryContextFromSession,
  deliveryContextKey,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryState,
  projectSessionDeliveryFields,
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
  sessionDeliveryRoute,
} from "./delivery-context.shared.js";
export type { DeliveryContext } from "./delivery-context.types.js";
