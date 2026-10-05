// Fixed setup marker projection; command outcome and logging stay with the workspace owner.
const setupStages = new Set([
  "repository_channel",
  "env_load",
  "credential_acquisition",
  "credential_transport",
  "msrustup_probe",
  "msrustup_install",
  "toolchain_probe",
  "toolchain_install",
  "provenance",
  "compiler_probe",
  "formatter_probe",
  "clippy_probe",
]);

export function summarizeWorkerSetupMarkers(stderr: string) {
  const markers: {
    helperStage: string;
    helperOutcome: string;
    helperExitCode?: number;
    helperElapsedMs?: number;
  }[] = [];
  let helperMarkerCount = 0;
  for (const line of stderr.split(/\r?\n/u).slice(0, -1)) {
    const marker =
      /^TEAMCLAW_SETUP_V1 stage=([a-z_]+) outcome=(started|succeeded|failed)(?: exit=(0|[1-9][0-9]{0,2}))?(?: elapsedMs=(0|[1-9][0-9]{0,9}))?$/u.exec(
        line,
      );
    if (
      !marker ||
      !setupStages.has(marker[1]!) ||
      (marker[3] !== undefined && (marker[2] !== "failed" || Number(marker[3]) > 255)) ||
      (marker[4] !== undefined && Number(marker[4]) > 2_147_483_647)
    ) {
      continue;
    }
    helperMarkerCount += 1;
    markers.push({
      helperStage: marker[1]!,
      helperOutcome: marker[2]!,
      helperExitCode: marker[3] === undefined ? undefined : Number(marker[3]),
      ...(marker[4] === undefined ? {} : { helperElapsedMs: Number(marker[4]) }),
    });
    // Retain a bounded sequence, not arbitrary script output or an overlapping duration sum.
    if (markers.length > 24) {
      markers.shift();
    }
  }
  return { ...markers.at(-1), helperMarkerCount, helperMarkers: markers };
}
