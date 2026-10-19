/** Build identity of the probed Gateway, reported against the install it would load next. */

export type GatewayIdentityReport = {
  version: string | null;
  /** Build the running process actually loaded; it cannot change without a restart. */
  buildId: string | null;
  /** Build recorded in the install's dist/ right now, when this host can read it. */
  installedBuildId?: string;
  restartRequired?: true;
};

type ProbedGateway = {
  server?: { version?: string | null; buildId?: string | null } | undefined;
  version?: string | null;
};

export function resolveGatewayIdentityReport(
  rpc: ProbedGateway | undefined,
  opts: { installedBuildId: string | undefined },
): GatewayIdentityReport {
  const buildId = rpc?.server?.buildId ?? null;
  const installedBuildId = opts.installedBuildId;
  return {
    version: rpc?.server?.version ?? rpc?.version ?? null,
    buildId,
    ...(installedBuildId ? { installedBuildId } : {}),
    // A build that lands under a running Gateway leaves it serving an install it can no
    // longer fully load: chunks it already imported keep working while everything it has
    // not reached yet resolves against replaced files. Only a restart clears that.
    ...(buildId && installedBuildId && buildId !== installedBuildId
      ? { restartRequired: true as const }
      : {}),
  };
}
