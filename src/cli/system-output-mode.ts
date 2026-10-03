import { getMachineOutputCommandPath } from "./machine-output-argv.js";

/** System query/control commands emit JSON even when `--json` is omitted. */
export function isSystemMachineOutput(argv: readonly string[]): boolean {
  return getMachineOutputCommandPath(argv, 3).slice(1).join(" ") === "presence";
}
