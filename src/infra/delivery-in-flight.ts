/**
 * Tracks delivery operations in progress for restart deferral.
 * Used so the gateway waits for in-flight deliveries before emitting SIGUSR1.
 */

let deliveryInFlightCount = 0;

export function incrementDeliveryInFlight(): void {
  deliveryInFlightCount += 1;
}

export function decrementDeliveryInFlight(): void {
  if (deliveryInFlightCount > 0) {
    deliveryInFlightCount -= 1;
  }
}

export function getDeliveryInFlightCount(): number {
  return deliveryInFlightCount;
}
