/** Reported placement only: no payload, provider handles, or mutable receipt aliases. */
export type DeliveryPlacementEvidence = Readonly<{
  channels: readonly string[];
  targets: readonly string[];
  threads: readonly string[];
  invalid: boolean;
}>;
