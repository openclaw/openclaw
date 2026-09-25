import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import type { InheritedToolPolicyV2 } from "../agents/inherited-tool-policy.schema.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  agentCommandMock,
  prepareGatewayReplyRuntimeForTest,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

export async function runGlobalSessionSendPolicyScenario(params: {
  dir: string;
  context: GatewayRequestContext;
  reply: (opts: unknown) => Promise<void>;
}): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  const sourceKey = "agent:main:dashboard:delegation-source";
  const mainStore = path.join(params.dir, "main", "sessions.json");
  const otherStore = path.join(params.dir, "other", "sessions.json");
  const config: OpenClawConfig = {
    session: { scope: "global", store: path.join(params.dir, "{agentId}", "sessions.json") },
    tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
    agents: {
      ownership: "explicit",
      entries: {
        main: { tools: { allow: ["read", "sessions_send"] } },
        other: { tools: { allow: ["read", "sessions_send", "exec"] } },
      },
    },
  };
  const policy: InheritedToolPolicyV2 = {
    clauses: [{ kind: "configured", allow: ["read", "sessions_send"] }],
    parameters: { exec: [], fileTools: [], sandbox: [], unsupported: [] },
  };
  const source = new AbortController();
  testState.sessionStorePath = mainStore;
  testState.agentsConfig = config.agents;
  testState.sessionConfig = config.session;
  try {
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    await writeSessionStore({
      agentId: "main",
      storePath: mainStore,
      entries: {
        global: { sessionId: "selected-global", updatedAt: Date.now() },
        [sourceKey]: { sessionId: "delegation-source", updatedAt: Date.now() },
      },
    });
    await writeSessionStore({
      agentId: "other",
      storePath: otherStore,
      entries: { global: { sessionId: "foreign-global", updatedAt: Date.now() } },
    });
    await prepareGatewayReplyRuntimeForTest({ force: true });
    const command = vi.mocked(agentCommandMock);
    command.mockReset();
    command.mockImplementation(params.reply);
    const { createOpenClawTools } = await import("../agents/openclaw-tools.js");
    const tool = createOpenClawTools({
      agentSessionKey: sourceKey,
      sessionId: "delegation-source",
      config,
      captureInheritedToolPolicyForDelegation: async () => ({
        policy,
        assertCurrent: () => source.signal.throwIfAborted(),
      }),
    }).find((candidate) => candidate.name === "sessions_send");
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }
    const send = (agentId: string) =>
      withPluginRuntimeGatewayContextResolver(
        () => params.context,
        () =>
          tool.execute(`global-policy-${agentId}`, {
            agentId,
            message: `assess the ${agentId} global session`,
            timeoutSeconds: 5,
          }),
      );

    const accepted = await send("main");
    expect(accepted.details, JSON.stringify(accepted.details)).toMatchObject({
      status: "ok",
      reply: "selected global assessment",
      sessionKey: "global",
    });
    expect(command.mock.calls[0]?.[0]).toMatchObject({
      agentId: "main",
      sessionId: "selected-global",
      sessionKey: "global",
    });
    await waitForGatewayActiveWork(10_000);
    command.mockClear();

    // The same logical key must neither borrow main's narrower policy nor route
    // the foreign request to main's physical row.
    const rejected = await send("other");
    expect(rejected.details, JSON.stringify(rejected.details)).toMatchObject({
      status: "error",
      error: expect.stringContaining("target task's action restrictions do not satisfy"),
    });
    expect(command).not.toHaveBeenCalled();
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: "global", storePath: mainStore })?.sessionId,
    ).toBe("selected-global");
    expect(
      loadSessionEntry({ agentId: "other", sessionKey: "global", storePath: otherStore })
        ?.sessionId,
    ).toBe("foreign-global");
  } finally {
    try {
      await waitForGatewayActiveWork(10_000);
    } finally {
      source.abort();
      testState.agentsConfig = undefined;
      testState.sessionConfig = undefined;
    }
  }
}
