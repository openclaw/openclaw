// Native Node callers load this source closure without a TypeScript import resolver.
import os from "node:os";

let translated: boolean | undefined;

/**
 * Whether this x86_64 Darwin process may be running under Rosetta.
 *
 * Rosetta reads guest stack above rsp while translating some syscalls (macOS 27 reads
 * [rsp+0x18, rsp+0x20) for write, getattrlist, proc_info and sysctl). Koffi enters foreign
 * calls at the top of its private stack, so thin libc syscall wrappers called through it fault
 * when the next page is unmapped. Native arm64 and Intel processes never read that memory.
 */
export function isRosettaTranslatedProcess(): boolean {
  if (process.platform !== "darwin" || process.arch !== "x64") {
    return false;
  }
  // Translated processes report the host's Apple CPU brand. Only genuine Intel hardware keeps
  // koffi syscalls; anything unrecognized takes the caller's portable path without a sysctl spawn.
  translated ??= !os.cpus()[0]?.model.startsWith("Intel");
  return translated;
}
