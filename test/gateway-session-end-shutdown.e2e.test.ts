// A real Gateway process must finish reset-started plugin work before SIGTERM exit.
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionsCreateResult } from "../packages/gateway-protocol/src/schema/sessions.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { withBuiltGateway } from "./helpers/built-gateway-proof.js";
import { GATEWAY_RESTART_TEST_KILL_MS } from "./helpers/gateway-restart-budget.js";
import { createTempDirTracker } from "./helpers/temp-dir.js";

const PLUGIN_ID = "session-end-shutdown-proof";
const SESSION_KEY = "agent:main:dashboard:session-end-shutdown-proof";
const WAIT_OPTIONS = { timeout: 10_000, interval: 25 } as const;

const fixtureDirs = createTempDirTracker();
afterEach(fixtureDirs.cleanup);

async function writeSessionEndPlugin(pluginDir: string, tracePath: string): Promise<void> {
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: PLUGIN_ID,
      name: "Session End Shutdown Proof",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    })}\n`,
  );
  await writeFile(
    path.join(pluginDir, "index.mjs"),
    `import { appendFileSync } from "node:fs";
export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.on("session_end", async (event) => {
      if (event.sessionKey !== ${JSON.stringify(SESSION_KEY)} || event.reason !== "reset") return;
      appendFileSync(${JSON.stringify(tracePath)}, "started\\n");
      await new Promise((resolve) => setTimeout(resolve, 10000));
      appendFileSync(${JSON.stringify(tracePath)}, "completed\\n");
    });
  },
};
`,
  );
}

async function readTrace(tracePath: string): Promise<string[]> {
  try {
    return (await readFile(tracePath, "utf8")).split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

it("finishes a real reset-started session_end hook after an operating-system SIGTERM", async () => {
  const fixtureDir = fixtureDirs.make("openclaw-session-end-shutdown-");
  const pluginDir = path.join(fixtureDir, "plugin");
  const tracePath = path.join(fixtureDir, "session-end.trace");
  await writeSessionEndPlugin(pluginDir, tracePath);

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
      } satisfies OpenClawConfig,
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      stopTimeoutMs: 10_000,
      // Signal the Gateway itself before the custody owner cancels its worker tree.
      gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
    },
    async (client, instance) => {
      await vi.waitFor(async () => {
        const created = await client.request<SessionsCreateResult>("sessions.create", {
          agentId: "main",
          key: SESSION_KEY,
        });
        expect(created.key).toBe(SESSION_KEY);
        expect(created.sessionId).toBeTruthy();
      }, WAIT_OPTIONS);

      await client.request("sessions.reset", { key: SESSION_KEY, reason: "reset" });
      await vi.waitFor(async () => {
        expect(await readTrace(tracePath), instance.logs()).toEqual(["started"]);
      }, WAIT_OPTIONS);

      const child = instance.child;
      if (!child) {
        throw new Error("Gateway process exited before its session-end hook was signaled");
      }
      const exited = once(child, "exit") as Promise<
        [code: number | null, signal: NodeJS.Signals | null]
      >;
      expect(child.kill("SIGTERM")).toBe(true);

      await expect(exited).resolves.toEqual([0, null]);
      await expect(readTrace(tracePath)).resolves.toEqual(["started", "completed"]);
    },
    { role: "operator", scopes: ["operator.admin", "operator.read", "operator.write"] },
  );
}, 120_000);
