import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";

export const CRON_HOOK_PROBE_ID = "cron-hook-effect-proof";

/** A registered plugin waits at a real HTTP boundary before its guarded outbound effect. */
export async function createCronHookEffectProbe(state: OpenClawTestState) {
  const gates = new Map<
    string,
    { entered: ReturnType<typeof createDeferred<void>>; response?: ServerResponse; effects: number }
  >(
    ["HOOK_ALLOWED", "HOOK_ROTATED"].map((marker) => [
      marker,
      { entered: createDeferred(), effects: 0 },
    ]),
  );
  const server = createServer((request, response) => {
    const [, action, marker] = (request.url ?? "").split("/");
    const gate = gates.get(marker ?? "");
    if (!gate) {
      response.writeHead(404).end();
    } else if (action === "wait") {
      gate.response = response;
      gate.entered.resolve();
    } else if (action === "effect" && request.method === "POST") {
      gate.effects += 1;
      response.end(`${marker}_REPLY`);
    } else {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Cron hook effect receiver did not bind");
  }
  const url = `http://127.0.0.1:${address.port}`;
  const pluginPath = state.path(CRON_HOOK_PROBE_ID);
  await fs.mkdir(pluginPath, { recursive: true });
  await fs.writeFile(
    path.join(pluginPath, "package.json"),
    JSON.stringify({
      name: CRON_HOOK_PROBE_ID,
      type: "commonjs",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  await fs.writeFile(
    path.join(pluginPath, "openclaw.plugin.json"),
    JSON.stringify({
      id: CRON_HOOK_PROBE_ID,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(pluginPath, "index.cjs"),
    `const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } = require("openclaw/plugin-sdk/ssrf-runtime");
const base = ${JSON.stringify(url)};
// Startup methods and request-scoped plugin instances share one test observation owner.
const state = globalThis[Symbol.for("openclaw.test.cronHookEffect")] ??= {
  calls: {}, runs: new Map(), providerStarts: 0,
  settled: Object.fromEntries(["HOOK_ALLOWED", "HOOK_ROTATED"].map(marker => [marker, Promise.withResolvers()])),
};
const { calls, runs, settled } = state;
async function request(action, marker) {
  const { response, release } = await fetchWithSsrFGuard({
    url: base + "/" + action + "/" + marker,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(base),
    init: { method: action === "effect" ? "POST" : "GET" },
  });
  try { return await response.text(); } finally { await release(); }
}
module.exports = {
  id: "${CRON_HOOK_PROBE_ID}",
  register(api) {
    api.on("before_agent_reply", async (event, ctx) => {
      const marker = ["HOOK_ALLOWED", "HOOK_ROTATED"].find(value => event.cleanedBody.includes(value));
      if (!marker) return;
      runs.set(ctx.runId, marker);
      const record = calls[marker] ??= { hooks: 0, providers: 0 };
      record.hooks++;
      try {
        await request("wait", marker);
        return { handled: true, reply: { text: await request("effect", marker) } };
      } catch (error) {
        record.error = error.message;
        throw error;
      } finally {
        settled[marker].resolve();
      }
    }, { eligibleTriggers: ["user"] });
    api.on("model_call_started", (_event, ctx) => {
      state.providerStarts++;
      const marker = runs.get(ctx.runId);
      if (marker) calls[marker].providers++;
    });
    api.registerGatewayMethod("cronHookProof.settled", async ({ params, respond }) => {
      await settled[params.marker].promise;
      respond(true, {});
    }, { scope: "operator.read" });
    api.registerGatewayMethod("cronHookProof.stats", ({ respond }) => respond(true, { calls, providerStarts: state.providerStarts }), { scope: "operator.read" });
  },
};
`,
  );
  return {
    pluginPath,
    gate(marker: string) {
      const gate = gates.get(marker);
      if (!gate) {
        throw new Error("Unknown hook probe marker");
      }
      return gate;
    },
    async close() {
      for (const gate of gates.values()) {
        gate.response?.end();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
