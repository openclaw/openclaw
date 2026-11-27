import { createTestEntrypoint } from "../infra/runtime-entrypoint.test-support.ts";

export const snapshotExportTestEntrypoint = createTestEntrypoint(
  import.meta.url,
  "trajectory",
)("export.snapshot.test-support");
