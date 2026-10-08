import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { repairCanonicalSessionKeys } from "./doctor-session-canonical-keys.test-support.js";

export const canonicalMemoryTestSupportModuleUrl = import.meta.url;

async function main(): Promise<void> {
  const onPhase = (phase: string) => {
    fs.writeSync(
      process.stderr.fd,
      `[doctor-canonical-phase] ${JSON.stringify({ phase, elapsedMs: Math.round(performance.now()) })}\n`,
    );
  };
  onPhase("imports-complete");
  const [stateDir, storeTemplate, mode] = process.argv.slice(2);
  if (!stateDir || !storeTemplate) {
    throw new Error("usage: <state-dir> <store-template>");
  }
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const result = await repairCanonicalSessionKeys(
    {
      apply: mode === "apply",
      cfg: {
        agents: { entries: { main: {} } },
        session: { store: storeTemplate },
      },
      env,
    },
    onPhase,
  );
  // The 160 MiB proof covers repair and result serialization, not unrelated Node shutdown tasks.
  onPhase("stdout-start");
  process.stdout.write(JSON.stringify(result), () => {
    onPhase("stdout-flushed");
    process.exit(0);
  });
}

// Node resolves the bundle through shared node_modules; compare canonical paths.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
