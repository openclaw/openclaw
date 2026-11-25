import { routeLogsToStderr } from "../logging/console.js";
import { projectUpdateConfig } from "./update-config-projection.js";

routeLogsToStderr();
try {
  process.stdout.write(`${JSON.stringify(await projectUpdateConfig())}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
