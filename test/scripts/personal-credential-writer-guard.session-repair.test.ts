import { expect, it } from "vitest";
import { inspectDatabaseWorkerBoundaries } from "../../scripts/lib/database-worker-compat.mts";

it.each([
  {
    file: "src/commands/doctor-relative-session-store.ts",
    operation: "repairRelativeSessionStores",
    owner: "src/state/config-machine-state-write.ts",
    module: "../state/config-machine-state-write.js",
    writer: "writeConfigMachineState",
    args: "receiptKey, fingerprint",
  },
  {
    file: "src/config/sessions/session-claim-repair-copy.ts",
    operation: "copySessionClaimForRepair",
    owner: "src/config/sessions/session-accessor.sqlite-node-artifacts.ts",
    module: "./session-accessor.sqlite-node-artifacts.js",
    writer: "copySessionNodeArtifactsForRepair",
    args: "source, destination, keys, canonicalKey",
  },
])(
  "keeps $operation's reviewed writer edge exact",
  ({ file, operation, owner, module, writer, args }) => {
    const call = `${writer}(${args});`;
    const inspect = (name: string, body = call) =>
      inspectDatabaseWorkerBoundaries(
        process.cwd(),
        new Map([
          [owner, `export function ${writer}() {}`],
          [file, `import { ${writer} } from '${module}'; function ${name}() { ${body} }`],
        ]),
      ).violations;

    expect(inspect(operation)).toEqual([]);
    expect(inspect("unreviewedRepair")).toEqual([expect.stringContaining("unreviewed")]);
    expect(inspect(operation, `${call} ${call}`)).toEqual([expect.stringContaining("unreviewed")]);
  },
);

it("retires the moved legacy claim writer edge", () => {
  const violations = inspectDatabaseWorkerBoundaries(
    process.cwd(),
    new Map([
      [
        "src/config/sessions/session-accessor.sqlite-node-artifacts.ts",
        "export function copySessionNodeArtifactsForRepair() {}",
      ],
      [
        "src/config/sessions/legacy-main-session-migration-operations.ts",
        `import { copySessionNodeArtifactsForRepair } from './session-accessor.sqlite-node-artifacts.js';
         function copyClaimCrossStore() { copySessionNodeArtifactsForRepair(); }`,
      ],
    ]),
  ).violations;
  expect(violations).toEqual([expect.stringContaining("unreviewed session membership writer")]);
});
