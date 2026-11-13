import process from "node:process";
import { isSupportedOpenClawNodeVersion } from "../../node-version.mjs";

const requiredFlag = process.argv[2];
process.stdout.write(
  !process.versions.bun &&
    isSupportedOpenClawNodeVersion(process.versions.node) &&
    (!requiredFlag || process.allowedNodeEnvironmentFlags.has(requiredFlag))
    ? process.execPath
    : "",
);
