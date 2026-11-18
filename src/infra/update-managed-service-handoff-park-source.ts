// Embedded verbatim in the sealed update helper, alongside the service recovery source.
export const MANAGED_HANDOFF_PARK_SOURCE = String.raw`
async function parkGatewayService() {
  if (params.operatorRestartWarning) throw new Error(params.operatorRestartWarning);
  const recovery = params.serviceRecovery;
  if (!recovery) return;
  assertGatewayParkOwner();
  if (recovery.kind === "schtasks") {
    await prepareTransferredGateway();
    assertGatewayParkOwner();
    pendingServiceStop = runServiceCommand("schtasks.exe", ["/End", "/TN", recovery.taskName], () => {
      restorationArmed = true;
      recordServiceStop();
    }, params.parentExitDeadlineAt, params.parentExitTimeoutMs);
    if ((await pendingServiceStop).code !== 0) throw new Error("scheduled task stop failed");
    return;
  }
  const systemd = recovery.kind === "systemd";
  let target;
  if (systemd) {
    const current = await inspectSystemdService(recovery.unit, params.parentExitDeadlineAt);
    if (
      !current ||
      current.Id !== recovery.unit ||
      current.LoadState !== "loaded" ||
      current.ActiveState !== "active" ||
      current.MainPID !== String(params.parentPid) ||
      !/^[1-9]\d*$/.test(current.ExecMainStartTimestampMonotonic || "") ||
      !/^[a-f0-9]{32}$/i.test(current.InvocationID || "")) {
      throw new Error("systemd service does not match the exact active gateway parent");
    }
    assertGatewayParkOwner();
    parkedServiceGeneration = current.ExecMainStartTimestampMonotonic;
    parkedServiceInvocation = current.InvocationID;
    parkedServiceFragment = current.FragmentPath;
  } else {
    if (recovery.kind !== "launchd") throw new Error("unsupported managed update supervisor");
    target = "gui/" + recovery.uid + "/" + recovery.label;
    const inspection = await runServiceCommand("launchctl", ["print", target], undefined, params.parentExitDeadlineAt);
    if (inspection.code !== 0 || parseLaunchctlJob(inspection.stdout, target).runtime.pid !== params.parentPid) {
      throw new Error("launchd service does not match the exact active gateway parent");
    }
    assertGatewayParkOwner();
  }
  await prepareTransferredGateway();
  assertGatewayParkOwner();
  if (!systemd) {
    restorationArmed = true;
    const disabled = await runServiceCommand("launchctl", ["disable", target], undefined, params.parentExitDeadlineAt);
    if (disabled.code !== 0) throw new Error("launchctl disable failed: " + disabled.stderr);
    assertGatewayParkOwner();
  }
  // Accepted spawn acknowledges parking; the exact stop stays open through parent exit.
  await new Promise((resolve, reject) => {
    pendingServiceStop = runServiceCommand(
      systemd ? "systemctl" : "launchctl",
      systemd ? ["--user", "stop", recovery.unit] : ["bootout", target],
      () => {
        if (systemd) restorationArmed = true;
        recordServiceStop();
        resolve();
      },
      params.parentExitDeadlineAt,
      systemd ? params.parentExitTimeoutMs : undefined,
    );
    pendingServiceStop.then((result) => {
      if (systemd ? !restorationArmed : result.code !== 0 && !isLaunchdNotLoaded(result)) {
        reject(new Error((systemd ? "systemd stop" : "launchctl bootout") + " failed: " + result.stderr));
      }
    });
  });
}
`.trim();
