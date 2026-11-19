import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  RuntimeProcessScriptFile,
  RuntimeProcessScriptFileOptions,
} from "../../runtime-process-scripts.generated.mjs";

export async function materializeRuntimeProcessScriptFileAsync(
  entry: { fileName: string; source: string },
  options: RuntimeProcessScriptFileOptions = {},
): Promise<{ url: URL; dispose(): Promise<void> }> {
  const directory = await fsp.mkdtemp(
    path.join(options.parentDirectory ?? os.tmpdir(), "openclaw-script-"),
  );
  const filename = path.join(directory, entry.fileName);
  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= fsp.rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
      disposal = undefined;
      process.emitWarning(
        `Runtime script cleanup failed at ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }));
  try {
    await fsp.writeFile(filename, entry.source, { mode: 0o600, flag: "wx" });
    return { url: pathToFileURL(filename), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** The generated bootstrap binds this operation to declared, built program sources. */
export function materializeRuntimeProcessScriptFile(
  entry: { fileName: string; source: string },
  options: RuntimeProcessScriptFileOptions = {},
): RuntimeProcessScriptFile {
  const directory = fs.mkdtempSync(
    path.join(options.parentDirectory ?? os.tmpdir(), "openclaw-script-"),
  );
  const filename = path.join(directory, entry.fileName);
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      disposed = true;
    } catch (error) {
      process.emitWarning(
        `Runtime script cleanup failed at ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  try {
    fs.writeFileSync(filename, entry.source, { mode: 0o600, flag: "wx" });
    return { url: pathToFileURL(filename), dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
