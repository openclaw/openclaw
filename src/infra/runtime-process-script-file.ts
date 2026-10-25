import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSecureTempRoot } from "@openclaw/fs-safe/secure-temp-root";
import type {
  RuntimeProcessScriptFile,
  RuntimeProcessScriptFileOptions,
} from "../../runtime-process-scripts.generated.mjs";

/** The generated bootstrap binds this operation to declared, built program sources. */
export function materializeRuntimeProcessScriptFile(
  entry: { fileName: string; source: string },
  options: RuntimeProcessScriptFileOptions = {},
): RuntimeProcessScriptFile {
  const parent =
    options.parentDirectory ??
    resolveSecureTempRoot({
      fallbackPrefix: "openclaw-runtime",
      warningPrefix: "[openclaw]",
      unsafeFallbackLabel: "runtime script directory",
    });
  const directory = fs.mkdtempSync(path.join(parent, "script-"));
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
