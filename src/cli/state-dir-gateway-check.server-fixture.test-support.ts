import fs from "node:fs";
import path from "node:path";
import * as json5 from "json5";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { GatewayServer } from "../gateway/server.js";
import { registerSealedRuntime } from "../infra/sealed-runtime-registry.js";

const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
if (!stateDir) {
  throw new Error("Gateway fixture requires a private state directory");
}
const control = path.join(path.dirname(path.resolve(stateDir)), "gateway-fixture-control");
fs.mkdirSync(control, { recursive: true, mode: 0o700 });
// HOME/state selectors do not isolate default custody stores outside the state family.
registerSealedRuntime({ json5, resolveSecureTempRoot: () => control });
const port = Number.parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? "0", 10);
const token = process.env.OPENCLAW_TEST_GATEWAY_TOKEN ?? "";
const minimal = process.argv.includes("--minimal-real-gateway");
let startupOperations:
  | ReturnType<typeof import("./gateway-cli/run-loop-startup.js").createGatewayStartupOperations>
  | undefined;
let server: GatewayServer | undefined;
let stopping = false;
let closePromise: Promise<void> | undefined;
let startup: Promise<void> = Promise.resolve();
const close = () => {
  stopping = true;
  startupOperations?.close();
  return (closePromise ??= (async () => {
    await Promise.allSettled([startup]);
    await runQaGatewayFixture(
      async () => {
        await server?.close();
      },
      async () => {
        await startupOperations?.drain();
      },
    );
  })());
};
const stop = () => {
  void close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
startup = (async () => {
  const [{ pinRuntimePaths }, { startGatewayServer }, { createGatewayStartupOperations }] =
    await Promise.all([
      import("../config/paths.js"),
      import("../gateway/server.js"),
      import("./gateway-cli/run-loop-startup.js"),
    ]);
  startupOperations = createGatewayStartupOperations();
  if (stopping) {
    startupOperations.close();
    return;
  }
  pinRuntimePaths();
  if (minimal) {
    const requestLog = process.env.OPENCLAW_TEST_GATEWAY_REQUEST_LOG;
    if (!requestLog) {
      throw new Error("Minimal Gateway fixture requires its synthetic request log");
    }
    const { coreGatewayHandlers } = await import("../gateway/server-methods.js");
    for (const method of ["sessions.list", "sessions.resolve"] as const) {
      const original = coreGatewayHandlers[method]!;
      coreGatewayHandlers[method] = async (options) => {
        // Test evidence only: persist before the real response, without cross-pipe ordering guesses.
        fs.appendFileSync(requestLog, JSON.stringify({ method, params: options.params }) + "\n");
        return await original(options);
      };
    }
  }
  if (stopping) {
    return;
  }
  server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token },
    controlUiEnabled: false,
    startupOperation: startupOperations.run,
    ...(minimal ? { sidecarStartup: "defer" as const } : {}),
  });
  await server.startupSettled;
  if (!stopping) {
    process.send?.({ port });
  }
})();
try {
  await startup;
} catch (error) {
  console.error(error);
  try {
    await close();
  } catch (cleanupError) {
    console.error(cleanupError);
  }
  process.exit(1);
}
