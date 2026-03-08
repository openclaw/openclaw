import type { RuntimeEnv } from "../runtime.js";
import { displayPath } from "../utils.js";
import { createConfigIO } from "./io.js";

type LogConfigUpdatedOptions = {
  path?: string;
  suffix?: string;
};

export function formatConfigPath(path: string = createConfigIO().configPath): string {
  return displayPath(path);
}

export function logConfigUpdated(runtime: RuntimeEnv, opts: LogConfigUpdatedOptions = {}): void {
  const path = formatConfigPath(opts.path ?? createConfigIO().configPath);
  const suffix = opts.suffix ? ` ${opts.suffix}` : "";
  runtime.log(`Updated ${path}${suffix}`);
}
