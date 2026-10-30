import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  writeRestartPlugin,
  readRestartTrace as readTrace,
} from "./gateway-restart.test-support.js";
import { withBuiltGateway } from "./helpers/built-gateway-proof.js";
import { GATEWAY_RESTART_TEST_KILL_MS } from "./helpers/gateway-restart-budget.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const PLUGIN_ID = "session-end-shutdown-proof";
const SESSION_KEY = "agent:main:dashboard:session-end-shutdown-proof";
const WAIT_OPTIONS = { timeout: 10_000, interval: 25 } as const;

const fixtureDirs = useAutoCleanupTempDirTracker(afterEach);

it("finishes a real reset-started session_end hook after an operating-system SIGTERM", async () => {
  const fixtureDir = fixtureDirs.make("openclaw-session-end-shutdown-");
  const pluginDir = path.join(fixtureDir, "plugin");
  const tracePath = path.join(fixtureDir, "session-end.trace");
  const releasePath = path.join(fixtureDir, "release-hook");
  await writeRestartPlugin(
    pluginDir,
    {
      id: PLUGIN_ID,
      name: "Session End Shutdown Proof",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    `import { appendFileSync, watch } from "node:fs";
export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.on("session_end", async (event) => {
      if (event.sessionKey !== ${JSON.stringify(SESSION_KEY)} || event.reason !== "reset") return;
      await new Promise((resolve) => {
        const watcher = watch(${JSON.stringify(fixtureDir)}, (_event, filename) => {
          if (filename !== "release-hook") return;
          watcher.close();
          resolve();
        });
        appendFileSync(${JSON.stringify(tracePath)}, "started\\n");
      });
      appendFileSync(${JSON.stringify(tracePath)}, "completed\\n");
    });
  },
};
`,
  );
  await withBuiltGateway(
    {
      name: "session-end-shutdown",
      config: {
        plugins: {
          enabled: true,
          allow: [PLUGIN_ID],
          load: { paths: [pluginDir] },
          entries: { [PLUGIN_ID]: { enabled: true } },
          slots: { memory: "none" },
        },
      },
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      stopTimeoutMs: 10_000,
      // Signal the Gateway itself before the custody owner cancels its worker tree.
      gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
    },
    async (client, instance) => {
      await vi.waitFor(
        () => client.request("sessions.create", { agentId: "main", key: SESSION_KEY }),
        WAIT_OPTIONS,
      );

      await client.request("sessions.reset", { key: SESSION_KEY, reason: "reset" });
      await vi.waitFor(async () => {
        expect(await readTrace(tracePath), instance.logs()).toEqual(["started"]);
      }, WAIT_OPTIONS);

      const child = instance.child;
      assert(child, "Gateway process exited before its session-end hook was signaled");
      const exited = once(child, "exit");
      expect(child.kill("SIGTERM")).toBe(true);
      await vi.waitFor(() => {
        expect(instance.logs()).toContain("received SIGTERM; shutting down");
      }, WAIT_OPTIONS);
      await fs.writeFile(releasePath, "release");

      await expect(exited).resolves.toEqual([0, null]);
      await expect(readTrace(tracePath)).resolves.toEqual(["started", "completed"]);
    },
    { role: "operator", scopes: ["operator.admin", "operator.read", "operator.write"] },
  );
}, 120_000);
