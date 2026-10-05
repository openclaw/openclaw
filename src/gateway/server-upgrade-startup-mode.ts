/** Maintenance is a native-owner capability, never inferred from an environment variable. */
export function isGatewayRestrictedUpgradeStartup(options: {
  updateCanary?: boolean;
  upgradeMaintenance?: unknown;
}): boolean {
  return (
    options.updateCanary === true ||
    options.upgradeMaintenance === true ||
    (typeof options.upgradeMaintenance === "object" && options.upgradeMaintenance !== null)
  );
}
