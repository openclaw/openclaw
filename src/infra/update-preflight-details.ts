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
} as const;

export function updatePreflightDetailMessage(code: string): string | undefined {
  return Object.entries(UPDATE_PREFLIGHT_DETAILS).find(([key]) => key === code)?.[1];
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
