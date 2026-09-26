// Embedded parent-lifetime checks for the sealed handoff helper.
export const MANAGED_HANDOFF_PARENT_SOURCE = String.raw`
function parentIdentityState() {
  return leaseStore.inspectProcessIdentity({ pid: params.parentPid, startIdentity: params.parentStartIdentity }, params.parentPid === process.ppid && !process.stdin.destroyed && !process.stdin.readableEnded);
}
function parentIdentityCurrent() {
  return parentIdentityState() === "live";
}

async function activateTransferredGateway() {
  await waitForTransferredRestartDelay();
  // Validation has its own budget. The shutdown reserve starts only at activation.
  params.parentExitDeadlineAt = Date.now() + params.parentExitTimeoutMs;
  await parkGatewayService();
  if (requiresRequesterAcknowledgement && !transferPrepared)
    throw new Error("Profile update has no accepted park operation");
  while (isPidAlive(params.parentPid)) {
    if (!ownsManagedUpdateLease()) throw new Error("managed update activation ownership lost");
    const parentState = parentIdentityState();
    if (parentState === "dead") break;
    if (parentState !== "live") {
      if (!isPidAlive(params.parentPid)) break;
      throw new Error("managed update parent identity changed during activation");
    }
    if (Date.now() >= params.parentExitDeadlineAt) {
      try { process.kill(params.parentPid, "SIGKILL"); } catch {}
      throw new Error("managed update parent exit exceeded the activation deadline");
    }
    await sleep(Math.min(25, Math.max(0, params.parentExitDeadlineAt - Date.now())));
  }
  await finishGatewayServicePark();
}
`;
