import { readRuntimeProbeInfo } from "./daemon-runtime-probe.js";

process.stdout.write(
  JSON.stringify(
    await readRuntimeProbeInfo(
      process.argv[2] === "bun" ? "bun" : "node",
      process.argv[3] || undefined,
    ),
  ),
);
