import type { ConfigSource } from "./types.js";
import { createConfigIO } from "../io.js";

export function createFileConfigSource(opts: {
  configPath: string;
  env: NodeJS.ProcessEnv;
}): ConfigSource {
  const io = createConfigIO({ configPath: opts.configPath, env: opts.env });
  return {
    kind: "file",
    watchPath: opts.configPath,
    readSnapshot: () => io.readConfigFileSnapshot(),
  };
}
