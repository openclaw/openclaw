import { defaultRuntime } from "../runtime.js";
import { ExpectedCliError } from "./failure-output.js";

export function failDevicesCommand(json: boolean | undefined, ...lines: string[]): void {
  // Throw JSON refusals to the root failure handler so stdout gets its one error document.
  if (json) {
    const message = lines.join("\n");
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }
  for (const line of lines) {
    defaultRuntime.error(line);
  }
  defaultRuntime.exit(1);
}
