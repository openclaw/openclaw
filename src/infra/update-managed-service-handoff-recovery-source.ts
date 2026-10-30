export const MANAGED_HANDOFF_RECOVERY_SOURCE = String.raw`async function restoreGatewayService(reason, decision = params.recovery, childStatus, previousGeneration = false) {
  if (managedUpdateLease?.action.kind !== "update" || !ownsManagedUpdateLease()) return false;
  let expectedRevision;
  const record = (restored) => recordManagedUpdateOutcome(
    restored ? reason : "managed-service-handoff-restore-failed", restored, childStatus, expectedRevision,
  );
  const refuse = async (message) => {
    if (message) appendLog(message);
    await record(false);
    return false;
  };
  if (decision?.serviceRestartSafe !== true || !decision.version) {
    return refuse("recovery refused: original runtime identity could not be verified");
  }
  const expectedVersion = decision.version;
  const expectedBuildId = decision.buildId;
  const recovery = params.serviceRecovery;
  let restored = false;
  let serviceRunning;
  let servicePid;
  const ownsRecovery = () => {
    try { return ownsManagedUpdateLease() && fs.realpathSync(params.updateLeaseKey) === params.updateLeaseKey; }
    catch { return false; }
  };
  const runOwned = (...args) => ownsRecovery()
    ? runServiceCommand(...args) : Promise.resolve({ code: 1, stdout: "", stderr: "recovery ownership lost" });
  const restart = () => runOwnedUpdateCommand("recovery", params.recoveryCommandArgv,
    params.recoveryTimeoutMs, params.cwd, previousGeneration
      ? { ...process.env, OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1" } : process.env);
  if (!ownsRecovery()) return false;
  // Activation may consume or replace the notification. Annotate only the
  // observed revision; notification persistence never decides recovery safety.
  if (childStatus) expectedRevision = await recordManagedUpdateOutcome(reason, undefined, childStatus);
  if (recovery?.kind === "systemd") {
    if (!pendingServiceStop || (await pendingServiceStop).code !== 0) {
      return refuse("recovery refused: exact systemd stop did not complete");
    }
    const parked = await inspectSystemdService(recovery.unit);
    // A Gateway that exits non-zero during the stop (KillMode=mixed) settles the unit
    // into ActiveState=failed with the parked identity retained; that is still the
    // exact parked generation and recovery stays safe. An owned candidate boot can
    // advance inactive-unit metadata. Only a verified full-generation rollback
    // permits recovering that later stopped invocation.
    if (!parked || parked.Id !== recovery.unit || parked.LoadState !== "loaded" ||
      (parked.ActiveState !== "inactive" && parked.ActiveState !== "failed") ||
      parked.MainPID !== "0" || !(previousGeneration || isParkedSystemdGeneration(parked, true)) ||
      !ownsRecovery()) {
      return refuse("recovery refused: parked systemd service identity changed or stop is incomplete");
    }
    const started = childStatus
      ? await restart()
      : await runOwned("systemctl", ["--user", "start", recovery.unit]);
    const current = ownsRecovery() && await inspectSystemdService(recovery.unit);
    const pid = /^[1-9]\d*$/.test(current?.MainPID || "") ? Number(current.MainPID) : undefined;
    serviceRunning = current && current.Id === recovery.unit
      ? current.ActiveState === "active" && isPidAlive(pid) : undefined;
    servicePid = serviceRunning ? pid : undefined;
    restored = !started.signal && started.code === 0 && Boolean(current && current.Id === recovery.unit &&
      current.LoadState === "loaded" && current.ActiveState === "active" &&
      /^[1-9]\d*$/.test(current.MainPID || "") && current.MainPID !== String(params.parentPid) &&
      isPidAlive(Number(current.MainPID)) &&
      /^[1-9]\d*$/.test(current.ExecMainStartTimestampMonotonic || "") &&
      current.ExecMainStartTimestampMonotonic !== parkedServiceGeneration);
  } else if (recovery?.kind === "launchd") {
    try {
      const target = "gui/" + recovery.uid + "/" + recovery.label;
      const deadline = Date.now() + params.recoveryTimeoutMs;
      const run = (args) => runOwned("launchctl", args, undefined, deadline);
      const before = await run(["print", target]);
      if (before.code === 0) {
        const pid = parseLaunchctlJob(before.stdout, target).runtime.pid;
        if (pid && pid !== params.parentPid) {
          return refuse("recovery refused: launchd service has another process generation");
        }
      } else if (!isLaunchdNotLoaded(before)) {
        return refuse();
      }
      if (childStatus) {
        const restarted = await restart();
        // The guarded CLI owns its restart deadline; identity inspection gets a fresh probe budget.
        const current = ownsRecovery()
          ? await runOwned("launchctl", ["print", target]) : null;
        const pid = current?.code === 0
          ? parseLaunchctlJob(current.stdout, target).runtime.pid : 0;
        serviceRunning = current?.code === 0 ? Boolean(pid && isPidAlive(pid)) : undefined;
        servicePid = serviceRunning ? pid : undefined;
        restored = !restarted.signal && restarted.code === 0 && Boolean(pid && pid !== params.parentPid && serviceRunning);
      } else {
        const enabled = await run(["enable", target]);
        let kickstarted = false;
        for (let inspection = enabled; enabled.code === 0 && Date.now() < deadline;) {
          inspection = await run(["print", target]);
          if (inspection.code === 0) {
            const pid = parseLaunchctlJob(inspection.stdout, target).runtime.pid;
            if (pid !== params.parentPid && isPidAlive(pid)) {
              restored = true;
              servicePid = pid;
              break;
            }
            // launchd retains the old label until its ExitTimeOut-bounded teardown completes.
            if (pid === params.parentPid) {
              await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
              continue;
            }
            if (kickstarted) break;
            kickstarted = true;
            inspection = await run(["kickstart", target]);
          } else if (isLaunchdNotLoaded(inspection)) {
            inspection = await run(["bootstrap", "gui/" + recovery.uid, recovery.plistPath]);
          } else break;
          if (inspection.code === 0) continue;
          const detail = inspection.stderr || inspection.stdout;
          if (inspection.code === 130 ||
            /already exists in domain|operation already in progress|bootstrap failed: 37/i.test(detail)) continue;
          if (kickstarted && isLaunchdNotLoaded(inspection)) continue;
          if (!/bootstrap failed: 5|input\/output error/i.test(detail)) break;
          await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
        }
        serviceRunning = restored;
      }
    } catch (error) {
      // Invalid native identity must refuse recovery, never retry it through the outer failure handler.
      return refuse("recovery refused: " + (error instanceof Error ? error.message : String(error)));
    }
  } else if (recovery?.kind === "schtasks") {
    restored = (await runOwned("schtasks.exe", ["/Run", "/TN", recovery.taskName])).code === 0;
  }
  // Manager liveness survives a failed readiness probe, but version facts require
  // the new process to answer; never reuse the pre-activation runtime identity.
  runLedger?.recordUpdateRunVerification(params.runId, {
    serviceRunning, pid: servicePid, runningVersion: undefined, runningBuildId: undefined, versionMatch: undefined,
    readyz: undefined, coreReady: undefined, settled: undefined, channelsReady: undefined, pluginErrors: undefined,
  });
  if (restored) {
    try {
      const { waitForGatewayUpdateRecovery } = await import(pathToFileURL(params.recoveryModulePath).href);
      if (!ownsRecovery()) throw new Error("managed update recovery ownership was lost");
      const health = await waitForGatewayUpdateRecovery(expectedVersion, expectedBuildId, params.recoveryTimeoutMs);
      restored = ownsRecovery() && health.healthy === true &&
        health.runtime?.status === "running" && health.gatewayVersion === expectedVersion &&
        (!expectedBuildId || health.gatewayBuildId === expectedBuildId);
      if (restored && serviceStoppedAtMs !== undefined) serviceDowntimeMs = Math.max(0, Date.now() - serviceStoppedAtMs);
      runLedger?.recordUpdateRunVerification(params.runId, {
        serviceRunning: health.runtime?.status === "running",
        pid: typeof health.runtime?.pid === "number" ? health.runtime.pid : undefined,
        runningVersion: health.gatewayVersion ?? undefined,
        runningBuildId: health.gatewayBuildId ?? undefined,
        versionMatch: health.gatewayVersion === expectedVersion && (!expectedBuildId || health.gatewayBuildId === expectedBuildId),
        settled: health.healthy === true,
        channelsReady: health.healthy === true && !health.channelProbeErrors?.length,
        pluginErrors: health.activatedPluginErrors?.map((error) => JSON.stringify(error)) ?? [],
      });
    } catch (error) {
      appendLog("Gateway recovery readiness failed: " + String(error));
      restored = false;
    }
  }
  appendLog("gateway service recovery " + (restored ? "succeeded (readiness and runtime identity verified)" : "failed"));
  const recorded = await record(restored);
  if (!recorded) {
    appendLog("managed update restoration result could not be durably recorded");
  }
  return restored;
}
`;
