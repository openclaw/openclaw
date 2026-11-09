import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hasCommandProcessCleanupError,
  readCommandProcessFailure,
} from "../process/exec-result.js";
import { ignoreMissingPath } from "./errno.js";

/** Isolate transport refs/config while publishing packs directly into the existing store. */
export async function withGitObjectStoreTransport<T>(
  cwd: string,
  command: (cwd: string, args: string[]) => Promise<string>,
  run: (staging: string, objects: string) => Promise<T>,
): Promise<T> {
  const [objects, metadata] = await Promise.all([
    command(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]),
    command(cwd, [
      "rev-parse",
      "--show-object-format",
      "--path-format=absolute",
      "--git-path",
      "shallow",
    ]),
  ]);
  const separator = metadata.indexOf("\n");
  const format = metadata.slice(0, separator);
  const shallow = metadata.slice(separator + 1);
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-fetch-"));
  let retainStaging = false;
  try {
    await command(staging, ["init", "--bare", "--template=", `--object-format=${format}`]);
    await fs.copyFile(shallow, path.join(staging, "shallow")).catch(ignoreMissingPath);
    return await run(staging, objects);
  } catch (error) {
    retainStaging =
      hasCommandProcessCleanupError(error) ||
      readCommandProcessFailure(error)?.cleanup === "uncertain";
    throw error;
  } finally {
    if (!retainStaging) {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
}
