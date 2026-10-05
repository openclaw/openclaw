export const observationRunId = "00000000-0000-4000-8000-000000000001";

export function requiredItem<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  if (!item) {
    throw new Error(`Missing fixture item ${index}`);
  }
  return item;
}

/** Common native custody; individual suites supply their exact artifacts and owner mappings. */
export function observationFixture(native: string) {
  const installation = "/qualification/npm/lib/node_modules/openclaw";
  const ledger = "/qualification/state/ledger.sqlite";
  const nativeArguments = ["--control-root", "/qualification/control"];
  return {
    schemaVersion: 1,
    purpose: "unchanged-artifact-historical-observation",
    runId: observationRunId,
    side: "after",
    selectedMappingId: "fresh",
    runCaptureMappingId: "capture",
    apply: [
      native,
      "--installation",
      installation,
      "--release-qualification",
      "--qualification-inspector",
      ...nativeArguments,
    ],
    resume: [
      native,
      "--installation",
      installation,
      "--qualification-inspector",
      ...nativeArguments,
      "--retained-run",
      "{{original-run-id}}",
      "--retained-ledger",
      ledger,
    ],
    nativeArguments,
    installation,
    ledger,
    protectedRoots: [installation, "/qualification/state"],
    serviceCgroups: [] as string[],
    timeoutMs: 1000,
  };
}
