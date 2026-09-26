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
} as const;

// Every managed-service refusal shares the managed-service-preflight reason; the code names the
// check that refused. Fixed text: the live messages carry Gateway PIDs and install paths.
export const MANAGED_SERVICE_PREFLIGHT_DETAILS = {
  "gateway-process-tree":
    "The update ran inside the Gateway process tree, so it could not stop the Gateway. Run openclaw update outside the Gateway, or /update from chat.",
  "gateway-triage-process-tree":
    "The update ran inside automatic triage, where stopping the Gateway would cancel the repair. Run openclaw update from a shell outside triage.",
  "gateway-service-process":
    "The update ran inside the Gateway service process, which cannot change the installation it serves. Run openclaw update from a terminal outside the service.",
  "service-foreground-conflict":
    "Another Gateway service uses this installation and is not verified offline. Stop it through its service owner, then update.",
  "service-rebind-unwritable":
    "The Gateway service definition is not writable, so the service cannot be rebound to this installation.",
  "service-changed-before-admission":
    "The managed Gateway service changed before database admission. Retry the update.",
  "service-ownership-unverified":
    "Gateway service ownership could not be verified or changed during the update. Run openclaw gateway status --deep and retry.",
  "handoff-ownership-unverified":
    "The update handoff or the Gateway's current ownership could not be verified. Retry the update from its current owner.",
} as const;

export type ManagedServicePreflightCode = keyof typeof MANAGED_SERVICE_PREFLIGHT_DETAILS;

export function updatePreflightDetailMessage(code: string): string | undefined {
  return Object.entries({ ...UPDATE_PREFLIGHT_DETAILS, ...MANAGED_SERVICE_PREFLIGHT_DETAILS }).find(
    ([key]) => key === code,
  )?.[1];
}

export function createUpdatePreflightFailure(
  code: keyof typeof UPDATE_PREFLIGHT_DETAILS,
  detail?: string,
) {
  const message = UPDATE_PREFLIGHT_DETAILS[code];
  return {
    message: detail ? `${message}\n${detail}` : message,
    failureFacts: [
      {
        check:
          code === "installation-unclassified"
            ? "installation-inspection"
            : "target-metadata-preflight",
        code,
        message,
      },
    ],
  };
}
