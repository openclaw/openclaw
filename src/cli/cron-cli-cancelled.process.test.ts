import { expect, it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createDeferredCore } from "../shared/deferred.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";
import { prepareGatewayCliFixture, tempDirs } from "./gateway-backed-exit.process.test-support.js";
import { startGateway } from "./gateway-backed-exit.test-helpers.js";

const TEST_TOKEN = "test-token";
const cliEntrypoint = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli);

/**
 * Ambient cancellation proof: `cron add` runs a `system.info` read (to build the
 * shell argv for --command) before its mutation. When the Gateway holds that read,
 * SIGINT must abort the read through the async-work signal so the CLI exits
 * promptly instead of hanging on the held request.
 */
it("exits promptly after SIGINT while the pre-mutation system.info read is held", async () => {
  const root = tempDirs.make("openclaw-cron-cancelled-read-");
  const systemInfoHeld = createDeferredCore();
  const gateway = await startGateway(
    (ws, frame) => {
      if (frame.method === "system.info") {
        // Hold the read: no response until the client aborts it.
        systemInfoHeld.resolve();
      }
    },
    (frame) => {
      expect(frame.params?.auth?.token).toBe(TEST_TOKEN);
      return {
        methods: ["system.info", "cron.add", "cron.status"],
        auth: { role: "operator", scopes: ["operator.admin"] },
      };
    },
  );

  const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
    mode: "remote",
    remote: { url: gateway.url, token: TEST_TOKEN },
  });

  try {
    const startedAt = Date.now();
    const result = await runCliProcessChild({
      nodeArgs: [
        ...resolveRuntimeWorkerArgv(cliEntrypoint),
        "cron",
        "add",
        "--cron",
        "* * * * *",
        "--command",
        "echo hello",
        "--name",
        "cancelled-read-test",
        "--json",
      ],
      env: {
        ...process.env,
        HOME: root,
        NODE_DISABLE_COMPILE_CACHE: "1",
        NODE_ENV: undefined,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: stateDir,
        VITEST: undefined,
      },
      interact: async (child) => {
        // Wait until the CLI has reached the held read, then interrupt it.
        await systemInfoHeld.promise;
        child.kill("SIGINT");
      },
    });
    const elapsedMs = Date.now() - startedAt;

    // The interrupt must land before the deadlock guard: a cancelled read must
    // not leave the CLI hanging on the held Gateway request.
    expect(result).toMatchObject({ signal: null });
    expect(elapsedMs).toBeLessThan(30_000);
  } finally {
    await gateway.close();
  }
});
