// Public descriptions are fixed text: registry responses and local paths stay local.
export const UPDATE_PREFLIGHT_DETAILS = {
  "installation-unclassified":
    "Installation ownership could not be determined. Run openclaw gateway status --deep and npm root -g; retry openclaw update from the owning installation or reinstall using the original method.",
  "target-registry-dist-tag":
    "The registry dist-tag did not resolve to a release. Check npm config get registry, then retry openclaw update --tag <published-version>.",
  "target-registry-metadata":
    "The registry package metadata could not be read. Check npm config get registry and registry connectivity, then retry openclaw update --tag <published-version>.",
  "target-version-resolution":
    "The target version is missing, invalid, or differs from the requested release. Verify the published version, then retry openclaw update --tag <published-version>.",
  "target-schema-metadata":
    "The target does not declare valid database schema support. Use a compatible artifact or retry openclaw update --tag <published-version> before initializing this profile.",
  "target-git-metadata":
    "The Git target manifest or revision could not be inspected. Check Git remote access and the selected ref, then retry openclaw update; a dry-run does not fetch missing objects.",
  "target-git-cache-stale":
    "The cached Git target differs from the current remote target. A dry-run leaves local refs unchanged, so the target remains unresolved. A real openclaw update will fetch and validate the current remote target.",
  "inside-gateway-process-tree":
    "The update is running inside the Gateway process tree. Use the Gateway update action for a managed handoff, or run openclaw update from a terminal outside the Gateway process tree.",
  "inside-gateway-service":
    "The update is running inside the Gateway's native service membership. Stopping the service would terminate this command. Run openclaw update from an independent terminal outside the service, or use the Gateway update action for a managed handoff.",
  "service-membership-unverified":
    "Native Gateway service membership could not be verified. No service teardown was attempted. Retry from an independent terminal after restoring native process inspection, or use the Gateway update action for a managed handoff.",
  "service-ancestry-unverified":
    "Process ancestry could not be fully inspected. Use the Gateway update action for a managed handoff, or retry from an independent terminal without inherited service markers.",
  "inside-triage-process-tree":
    "This maintenance command cannot stop the Gateway from inside its automatic triage process tree: stopping the service would cancel this repair. Use read-only diagnosis or safe offline artifact repair followed by an atomic `openclaw gateway restart`, or run stop-requiring maintenance from a shell outside automatic triage. Report this blocker if repair cannot proceed safely.",
  "foreground-handoff-unverified":
    "The foreground Gateway update handoff could not be verified. Retry through the Gateway update action or from a terminal outside its process tree.",
  "service-not-offline":
    "Another Gateway service uses this installation and is not verified offline. Stop it through its service owner before updating the foreground Gateway.",
  "service-definition-not-writable":
    "The Gateway cannot be rebound to this installation without a writable service definition. Have the service owner repair its definition, then retry openclaw update.",
  "service-context-changed":
    "The managed Gateway service changed before database admission. Retry openclaw update so its package root and state are inspected together.",
  "service-ownership-changed":
    "Gateway service ownership changed after admission. Run openclaw gateway status --deep to inspect its current owner, then retry openclaw update.",
  "service-definition-changed":
    "The Gateway service definition changed after admission. Retry openclaw update against its current configuration.",
  "service-mutation-refused":
    "Gateway service management is unavailable for this supervisor or installation identity. Run openclaw gateway status --deep and retry through the service owner's update workflow.",
  "service-process-changed":
    "The Gateway process changed during maintenance drain. Run openclaw gateway status --deep to inspect its current service, then retry openclaw update.",
  "task-ownership-unverified":
    "Scheduled Task ownership could not be verified. Inspect the task's autostart state through its service owner, then retry openclaw update.",
} as const;

export function updatePreflightDetailMessage(code: string): string | undefined {
  return Object.entries(UPDATE_PREFLIGHT_DETAILS).find(([key]) => key === code)?.[1];
}

export function createUpdatePreflightFailure(
  code: keyof typeof UPDATE_PREFLIGHT_DETAILS,
  detail?: string,
  check = code === "installation-unclassified"
    ? "installation-inspection"
    : "target-metadata-preflight",
) {
  const message = UPDATE_PREFLIGHT_DETAILS[code];
  return {
    message: detail ? `${message}\n${detail}` : message,
    failureFacts: [
      {
        check,
        code,
        message,
      },
    ],
  };
}
