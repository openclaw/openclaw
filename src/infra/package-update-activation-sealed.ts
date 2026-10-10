import "./sealed-runtime-bootstrap.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "./errors.js";
import {
  openPackageActivationJournal,
  assertPackageActivationOperation,
  isPackageActivationComplete,
  packageActivationIdentity,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { assertPackageActivationRecoveryRuntime } from "./package-update-activation-sqlite.js";
import {
  readPackageActivationStatus,
  runPackageActivationRecovery,
  settlePendingPackageActivation,
} from "./package-update-activation.js";

try {
  const helper = fileURLToPath(import.meta.url);
  await assertPackageActivationRecoveryRuntime(helper);
  const anchor = process.argv[3];
  const operationId = process.argv[5];
  const action = process.argv[6];
  if (
    process.argv.length !== 7 ||
    process.argv[2] !== "--anchor" ||
    process.argv[4] !== "--operation" ||
    !anchor ||
    !operationId ||
    (action !== "status" && action !== "repair" && action !== "retire")
  ) {
    throw new Error(
      "Usage: <node|bun> recovery.mjs --anchor absolute-path --operation operation-id status|repair|retire",
    );
  }
  if (path.resolve(anchor) !== anchor) {
    throw new Error("Package recovery anchor must be an absolute canonical path.");
  }
  const journal = openPackageActivationJournal(anchor);
  const record = action === "status" ? journal.read() : (await journal.readForRecovery()).record;
  assertPackageActivationOperation(record, operationId);
  const complete = isPackageActivationComplete(anchor, record);
  const stagedHelper = record.descriptor.preparation.find(
    (entry) => entry.name === "helper",
  )?.source;
  if (
    !complete &&
    ((helper !== resolvePackageActivationHelper(anchor) && helper !== stagedHelper) ||
      packageActivationIdentity(helper, false) !== record.descriptor.helperIdentity ||
      createHash("sha256").update(fs.readFileSync(helper)).digest("hex") !==
        record.descriptor.helperDigest)
  ) {
    throw new Error(
      "Invoked helper is not the recorded package recovery object. Preserve the journal and use the original helper for unfinished recovery.",
    );
  }
  if (action === "repair" && !complete) {
    console.error(
      "Repair may republish the recorded candidate into a missing installation. Keep other package managers stopped. This does not restart or verify the Gateway.",
    );
  }
  const result =
    action === "status" || complete
      ? await readPackageActivationStatus(anchor, operationId)
      : await runPackageActivationRecovery(anchor, action, operationId);
  if (complete && action !== "status") {
    const settled = await settlePendingPackageActivation(
      record.descriptor.authority.installKey,
      undefined,
      record,
    );
    if (fs.existsSync(resolvePackageActivationJournalPath(anchor))) {
      throw new Error(
        `${settled?.warning ?? "Completed receipt remains active."} Preserve the journal and retry this recovery command before updating with the older CLI.`,
      );
    }
    console.error(
      `Completed package receipt preserved at ${settled?.retained}.${settled?.warning ? ` ${settled.warning}` : ""}`,
    );
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Package publication recovery refused: ${formatErrorMessage(error)}`);
  process.exitCode = 1;
}
