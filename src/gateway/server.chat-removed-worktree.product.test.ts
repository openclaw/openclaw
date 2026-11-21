import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import * as sandbox from "../agents/sandbox/context.js";
import { updateRegistryWorktree } from "../agents/worktrees/registry.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import {
  createProductState,
  productModelConfig,
  productProvider,
} from "./server.chat-product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";
import { resolveLocalWorkspaceOwner } from "./worker-environments/local-workspace-projection.js";

it("explains a removed active session worktree without a snapshot before preparing its sandbox", async () => {
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
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
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
    await updateRegistryWorktree(process.env, created.worktree.id, { snapshotRef: undefined });
    await expect(fs.access(created.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
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
    const errorMessage = await terminal.promise;
    expect(errorMessage).toContain(
      "This session's worktree was removed by cleanup or deletion. Use Restore in Settings > Worktrees (worktrees.restore), or start a new session.",
    );
    expect(errorMessage).toContain(created.worktree.id);
    await expect(fs.access(created.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
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

it(
  "restores saved work on chat.send before the agent and Review consume it",
  { timeout: 90_000 },
  async () => {
    const state = await createProductState("chat-auto-restore-worktree");
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const requests: string[] = [];
    const failures: unknown[] = [];
    const providerServer = productProvider(failures, (body, response) => {
      requests.push(body);
      writeOpenAiResponsesText(response, {
        text: "Continued the saved task.",
        messageId: randomUUID(),
        responseId: randomUUID(),
      });
    });
    const sessionKey = "agent:main:auto-restored-worktree";
    const startup: unknown[] = [];
    const failed = createDeferredCore<string>();
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const provider = buildMockOpenAiResponsesProvider(
        await listenProvider(providerServer),
        "worktree-restore",
      );
      const model = productModelConfig(state.workspaceDir, provider);
      gateway = await startGatewayWithClient({
        cfg: {
          agents: { defaults: { ...model.defaults, utilityModel: "", sandbox: { mode: "off" } } },
          models: model.models,
          plugins: { enabled: false, slots: { memory: "none" } },
          tools: { profile: "minimal" },
          gateway: { auth: { mode: "token", token: "synthetic-auto-restore-worktree" } },
        },
        configPath: state.configPath,
        token: "synthetic-auto-restore-worktree",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent(event) {
          const payload = event.payload;
          if (!isRecord(payload) || payload.sessionKey !== sessionKey) {
            return;
          }
          if (
            event.event === "agent" &&
            payload.stream === "run_status" &&
            isRecord(payload.data)
          ) {
            startup.push(payload.data.phase);
          }
          if (event.event === "chat" && payload.state === "error") {
            failed.resolve(String(payload.errorMessage));
          }
        },
      });
      await gateway.server.startupSettled;
      const { client } = gateway;
      const created = await client.request<{ worktree: { id: string; path: string } }>(
        "sessions.create",
        {
          key: sessionKey,
          worktree: true,
          worktreeSource: "empty",
        },
      );
      const saved = path.join(created.worktree.path, "saved-task.txt");
      await fs.writeFile(saved, "saved work survives cleanup\n");
      expect(await client.request("worktrees.remove", { id: created.worktree.id })).toMatchObject({
        removed: true,
      });
      await expect(client.request("sessions.diff", { sessionKey })).rejects.toThrow(
        "worktree was removed",
      );
      await expect(fs.access(saved)).rejects.toMatchObject({ code: "ENOENT" });
      startup.length = 0;
      const run = await client.request<{ runId: string }>("chat.send", {
        sessionKey,
        message: "Continue the saved task.",
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      expect(
        await client.request(
          "agent.wait",
          { runId: run.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        ),
      ).toMatchObject({ status: "ok" });
      expect(requests).toHaveLength(1);
      expect(startup).toContain("preparing_workspace");
      expect(failures).toEqual([]);
      expect(await fs.readFile(saved, "utf8")).toBe("saved work survives cleanup\n");
      expect(await client.request("sessions.diff", { sessionKey })).toMatchObject({
        files: expect.arrayContaining([expect.objectContaining({ path: "saved-task.txt" })]),
      });
      await client.request("worktrees.remove", { id: created.worktree.id });
      await updateRegistryWorktree(process.env, created.worktree.id, {
        snapshotRef: "refs/openclaw/snapshots/unavailable",
      });
      await client.request("chat.send", {
        sessionKey,
        message: "Continue again.",
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      expect(await failed.promise).toContain(
        "Automatic worktree restore failed (snapshot-invalid)",
      );
      expect(requests).toHaveLength(1);
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "worktree auto-restore proof complete" });
      }
      await closeProvider(providerServer);
      vi.unstubAllEnvs();
      await state.cleanup();
    }
  },
);
