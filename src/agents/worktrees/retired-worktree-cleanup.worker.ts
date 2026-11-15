import { rmSync } from "node:fs";

const directory = process.argv[2];
if (!directory) {
  throw new Error("Retired checkout path is required");
}
rmSync(directory, { recursive: true, force: true });
