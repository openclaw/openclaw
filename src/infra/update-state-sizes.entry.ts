import fs from "node:fs";
import { hasNodeErrorCode } from "./path-guards.js";
import { UPDATE_STATE_INSPECTION_PROGRESS_PREFIX } from "./update-state-inspection-protocol.js";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const { files }: { files: string[] } = JSON.parse(input);
  const result: Array<{ path: string; sizeBytes?: string }> = [];
  const progress = (pathname: string) => {
    try {
      fs.writeSync(
        2,
        UPDATE_STATE_INSPECTION_PROGRESS_PREFIX +
          JSON.stringify({ phase: "metadata inventory", path: pathname }) +
          "\n",
      );
    } catch (error) {
      // A full advisory pipe must not block the metadata operation.
      if (!hasNodeErrorCode(error, "EAGAIN") && !hasNodeErrorCode(error, "EWOULDBLOCK")) {
        throw error;
      }
    }
  };
  for (const file of files) {
    let size: bigint | undefined;
    progress(file);
    try {
      size = fs.statSync(file, { bigint: true }).size;
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT")) {
        result.push({ path: file });
      }
      continue;
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      progress(file + suffix);
      try {
        size += fs.statSync(file + suffix, { bigint: true }).size;
      } catch (error) {
        if (!hasNodeErrorCode(error, "ENOENT")) {
          size = undefined;
          break;
        }
      }
    }
    result.push({ path: file, sizeBytes: size?.toString() });
  }
  process.stdout.write(JSON.stringify(result));
});
