import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function withTempConfig(params: {
  cfg: unknown;
  run: () => Promise<void>;
  prefix?: string;
}): Promise<void> {
  const prevConfigPath = process.env.SMART_AGENT_NEO_CONFIG_PATH;
  const prevDisableCache = process.env.SMART_AGENT_NEO_DISABLE_CONFIG_CACHE;

  const dir = await mkdtemp(path.join(os.tmpdir(), params.prefix ?? "smart-agent-neo-test-config-"));
  const configPath = path.join(dir, "smart-agent-neo.json");

  process.env.SMART_AGENT_NEO_CONFIG_PATH = configPath;
  process.env.SMART_AGENT_NEO_DISABLE_CONFIG_CACHE = "1";

  try {
    await writeFile(configPath, JSON.stringify(params.cfg, null, 2), "utf-8");
    await params.run();
  } finally {
    if (prevConfigPath === undefined) {
      delete process.env.SMART_AGENT_NEO_CONFIG_PATH;
    } else {
      process.env.SMART_AGENT_NEO_CONFIG_PATH = prevConfigPath;
    }
    if (prevDisableCache === undefined) {
      delete process.env.SMART_AGENT_NEO_DISABLE_CONFIG_CACHE;
    } else {
      process.env.SMART_AGENT_NEO_DISABLE_CONFIG_CACHE = prevDisableCache;
    }
    await rm(dir, { recursive: true, force: true });
  }
}
