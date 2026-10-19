// Opt-in proof that a real model continues authorized work after an unresolved assignee.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { isLiveTestEnabled } from "../src/agents/live-test-helpers.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

it.skipIf(!isLiveTestEnabled() || process.env.OPENCLAW_LIVE_OWNER_ASSIGNMENT !== "1")(
  "continues authorized work when owner assignment and profile lookup cannot resolve a person",
  { timeout: 240_000 },
  async (ctx) => {
    if (!process.env.OPENAI_API_KEY) {
      ctx.skip("OPENAI_API_KEY is required for live owner-assignment proof");
      return;
    }
    const profile = "owner-proof-" + randomUUID();
    const instance = await createOpenClawTestInstance({
      name: profile,
      entrypoint: ["openclaw.mjs", "--profile", profile],
      state: { layout: "split" },
      config: {
        plugins: { allow: ["openai"], slots: { memory: "none" } },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-6.1-sol" },
            models: { "openai/gpt-6.1-sol": { agentRuntime: { id: "openclaw" } } },
            heartbeat: { every: "0m" },
            thinkingDefault: "low",
            skills: [],
          },
          entries: { main: {} },
        },
        tools: { profile: "coding", allow: ["sessions", "write"] },
      },
      env: {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
      startTimeoutMs: 120_000,
      stopTimeoutMs: 30_000,
    });
    try {
      const configured = await instance.cli([
        "config",
        "set",
        "agents.defaults.workspace",
        instance.state.workspaceDir,
      ]);
      expect(configured.code, configured.stderr).toBe(0);
      await instance.startGateway();
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      try {
        const sessionKey = "agent:main:" + profile;
        const output = path.join(instance.state.workspaceDir, "ownership-proof.txt");
        const response = await client.request<{ status: string }>(
          "agent",
          {
            sessionKey,
            message:
              "This is a disposable ownership-recovery test. First call sessions assign_owner for the current session, ownerType human, ownerId 999999999999999999 (a deliberately unknown channel sender ID). After it is rejected, call sessions owner_profiles with githubAccountIds [999999999]. The empty lookup is expected: do not guess an identity, create links, or change permissions. Then continue the independent authorized task: write ownership-proof.txt in the workspace with exactly OWNER_RECOVERY_CONTINUED followed by a newline. Finish by reporting OWNER_RECOVERY_CONTINUED and the unresolved assignee. Use the tools, not a hypothetical plan.",
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { expectFinal: true, timeoutMs: 180_000 },
        );
        expect(response.status).toBe("ok");
        const history = await client.request<{ messages: unknown[] }>("chat.history", {
          sessionKey,
          limit: 100,
        });
        const recorded = JSON.stringify(history.messages);
        expect(recorded).toContain('"assign_owner"');
        expect(recorded).toContain("Gateway profile ID");
        expect(recorded).toContain('"owner_profiles"');
        expect(await fs.readFile(output, "utf8")).toBe("OWNER_RECOVERY_CONTINUED\n");
      } finally {
        await disconnectGatewayClient(client);
      }
    } finally {
      await instance.cleanup();
    }
  },
);
