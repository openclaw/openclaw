import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type ProvisionCommandOpts = {
  backend?: string;
  model?: string;
  port?: string;
  verify?: boolean;
};

export async function provisionCommand(
  opts: ProvisionCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  // Lazy-load the provision module to keep CLI startup fast.
  const { provision, verifyCompletion, ALL_BACKENDS } =
    await import("../gemmaclaw/provision/index.js");
  type BackendId = (typeof ALL_BACKENDS)[number];

  const backend = opts.backend as BackendId | undefined;

  if (!backend || !ALL_BACKENDS.includes(backend)) {
    runtime.error(
      `Invalid backend: ${backend ?? "(none)"}. Choose one of: ${ALL_BACKENDS.join(", ")}`,
    );
    runtime.exit(1);
    return;
  }

  const port = opts.port ? Number(opts.port) : undefined;
  if (opts.port !== undefined && (Number.isNaN(port) || !port || port < 1 || port > 65535)) {
    runtime.error(`Invalid port: ${opts.port}`);
    runtime.exit(1);
    return;
  }

  const progress = (msg: string) => runtime.log(msg);

  try {
    const result = await provision({
      backend,
      model: opts.model,
      port,
      progress,
    });

    runtime.log("");
    runtime.log(`Backend:  ${result.backend}`);
    runtime.log(`Model:    ${result.modelId}`);
    runtime.log(`API:      ${result.handle.apiBaseUrl}`);
    runtime.log(`PID:      ${result.handle.pid}`);

    if (opts.verify !== false) {
      runtime.log("");
      runtime.log("Verifying chat completion...");

      const verification = await verifyCompletion(result.handle.apiBaseUrl, result.modelId);

      if (verification.ok) {
        runtime.log(`Verification passed. Response: "${verification.content}"`);
      } else {
        runtime.error(`Verification failed: ${verification.error}`);
        await result.handle.stop();
        runtime.exit(1);
        return;
      }
    }

    runtime.log("");
    runtime.log("Provisioning complete. The runtime is running in the background.");
    runtime.log(`To stop it: kill ${result.handle.pid}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runtime.error(`Provisioning failed: ${message}`);
    runtime.exit(1);
  }
}
