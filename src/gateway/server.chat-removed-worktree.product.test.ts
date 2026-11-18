import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import * as sandbox from "../agents/sandbox/context.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createProductState, productModelConfig } from "./server.chat-product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";
import { resolveLocalWorkspaceOwner } from "./worker-environments/local-workspace-projection.js";

it("explains a removed active session worktree before preparing its sandbox", async () => {
  const state = await createProductState("chat-removed-worktree");
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
  const terminal = createDeferredCore<string>();
  const sessionKey = "agent:main:removed-worktree";
  const provider = buildMockOpenAiResponsesProvider("http://127.0.0.1:1", "removed-worktree");
  const model = productModelConfig(state.workspaceDir, provider);
  const cfg = {
    agents: { defaults: { ...model.defaults, sandbox: { mode: "all" as const } } },
    models: model.models,
    plugins: { enabled: false, slots: { memory: "none" } },
    gateway: { auth: { mode: "token" as const, token: "synthetic-removed-worktree" } },
  };
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  try {
    gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token: "synthetic-removed-worktree",
      mode: "backend",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      onEvent(event) {
        const payload = event.payload;
        if (
          event.event === "chat" &&
          isRecord(payload) &&
          payload.sessionKey === sessionKey &&
          payload.state === "error"
        ) {
          terminal.resolve(String(payload.errorMessage));
        }
      },
    });
    await gateway.server.startupSettled;
    const { client } = gateway;
    const created = await client.request<{ worktree: { id: string; path: string } }>(
      "sessions.create",
      { key: sessionKey, worktree: true, worktreeSource: "empty" },
    );
    expect(await client.request("worktrees.remove", { id: created.worktree.id })).toMatchObject({
      removed: true,
    });
    expect(loadSessionEntry({ sessionKey, agentId: "main" })?.archivedAt).toBeUndefined();
    using preparation = vi.spyOn(sandbox, "resolveSandboxContext");
    const scope = { sessionKey, agentId: "main" };
    const entry = loadSessionEntry(scope);
    if (!entry) {
      throw new Error("Created session is missing");
    }
    const activity = { lastInteractionAt: 100, lastActivityAt: 200 };
    await upsertSessionEntryCore(scope, { ...entry, ...activity });
    for (const sourceTool of ["subagent_announce", "subagent_settle"]) {
      await expect(
        client.request(
          "agent",
          {
            sessionKey,
            expectedExistingSessionId: entry.sessionId,
            message: "The child was interrupted.",
            idempotencyKey: randomUUID(),
            inputProvenance: { kind: "inter_session", sourceTool },
          },
          { expectFinal: true },
        ),
      ).rejects.toThrow("worktree was removed");
      expect(loadSessionEntry(scope)).toMatchObject(activity);
    }
    await client.request("chat.send", {
      sessionKey,
      message: "Continue the task.",
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    expect(await terminal.promise).toContain(
      "This session's worktree was removed by cleanup or deletion. Use Restore in Settings > Worktrees (worktrees.restore), or start a new session.",
    );
    expect(preparation).not.toHaveBeenCalled();
    expect(loadSessionEntry(scope)?.lastInteractionAt).toBeGreaterThan(activity.lastInteractionAt);
    // Bypassing admission must still refuse a removed binding at the projection owner.
    await expect(resolveLocalWorkspaceOwner({ cfg, agentId: "main", sessionKey })).rejects.toThrow(
      "Local sandbox managed workspace owner changed",
    );
  } finally {
    if (gateway) {
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "removed worktree proof complete" });
    }
    vi.unstubAllEnvs();
    await state.cleanup();
  }
});
