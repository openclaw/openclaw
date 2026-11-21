#!/usr/bin/env node
// Dedicated cold-process entrypoint for native provider hook relays.
import process from "node:process";
import { runNativeHookRelayCliFromArgv } from "./native-hook-relay-cli.js";

process.title = "openclaw-hooks";
let exitCode = 1;
try {
  exitCode = await runNativeHookRelayCliFromArgv(process.argv);
} catch (error) {
  process.stderr.write(
    `native hook relay failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
// The relay joins its transport cleanup; natural exit drains both output pipes
// and disposes the V8 isolate before joining compiler workers.
process.exitCode = exitCode;
