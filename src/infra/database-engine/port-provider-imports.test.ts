import { expect, it } from "vitest";
import { vitestWorkerDeclarationEntries } from "../../../scripts/lib/vitest-worker-declarations.mts";
import { findSourceImportBackedges } from "../../../test/helpers/source-import-closure.js";

it("keeps family registration and operation cores independent of worker preparation", () => {
  expect(
    findSourceImportBackedges(
      [
        "src/infra/database-engine/port-provider.ts",
        "src/infra/database-engine/workboard-port.ts",
        "src/infra/database-engine/state-port.ts",
        "src/infra/database-engine/logbook-port.ts",
        "src/infra/database-engine/team-reports-port.ts",
        "src/infra/database-engine/port.worker.ts",
        "src/snapshot/database-backup-core.worker.ts",
      ],
      [
        "src/infra/database-engine/config.ts",
        "src/infra/database-engine/workboard-port-descriptor.ts",
        "src/infra/database-engine/state-port-descriptor.ts",
        "src/infra/database-engine/logbook-port-descriptor.ts",
        "src/infra/database-engine/team-reports-port-descriptor.ts",
        "src/plugins/bundled-dir.ts",
        "src/plugins/public-surface-loader.ts",
        ...Object.values(vitestWorkerDeclarationEntries),
      ],
    ),
  ).toEqual([]);
});
