import process from "node:process";

const requiredFlag = process.argv[2];
process.stdout.write(
  !process.versions.bun && (!requiredFlag || process.allowedNodeEnvironmentFlags.has(requiredFlag))
    ? process.execPath
    : "",
);
