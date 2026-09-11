import "./sealed-runtime-bootstrap.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "./errors.js";
import {
  readPackageActivationStatus,
  runPackageActivationRecovery,
} from "./package-update-activation.js";
import { isSupportedNodeVersion } from "./runtime-guard.js";

try {
  if (
    process.platform === "win32" ||
    !isSupportedNodeVersion(process.versions.node) ||
    process.versions.bun
  ) {
    throw new Error("Package publication recovery requires supported external Node on POSIX.");
  }
  const action = process.argv[2];
  if (
    process.argv.length !== 3 ||
    (action !== "status" && action !== "repair" && action !== "retire")
  ) {
    throw new Error("Usage: node recovery.mjs status|repair|retire");
  }
  const anchor = path.dirname(fileURLToPath(import.meta.url));
  if (action === "repair") {
    console.error(
      "Repair may republish the recorded candidate into a missing installation. Keep other package managers stopped. This does not restart or verify the Gateway.",
    );
  }
  const result =
    action === "status"
      ? await readPackageActivationStatus(anchor)
      : await runPackageActivationRecovery(anchor, action);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Package publication recovery refused: ${formatErrorMessage(error)}`);
  process.exitCode = 1;
}
