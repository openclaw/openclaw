import os from "node:os";

let translated: boolean | undefined;

/**
 * Whether this x86_64 Darwin process is running under Rosetta.
 *
 * Darwin process-argument inspection remains unavailable under translation in
 * proc-safe. The census uses this fact to name the supported native runtime.
 */
export function isRosettaTranslatedProcess(): boolean {
  if (process.platform !== "darwin" || process.arch !== "x64") {
    return false;
  }
  // Translated processes report the host's Apple CPU brand ("Apple M3 Ultra"; early Rosetta
  // used "VirtualApple"), which x86 hardware never does. Avoids spawning sysctl for this.
  translated ??= os.cpus()[0]?.model.includes("Apple") === true;
  return translated;
}
