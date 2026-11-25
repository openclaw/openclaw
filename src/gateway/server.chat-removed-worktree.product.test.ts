import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import * as sandbox from "../agents/sandbox/context.js";
import * as checkout from "../agents/worktrees/checkout-materialize.js";
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
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "./worker-environments/local-workspace-projection.js";

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

it.each(["snapshot", "fresh", "protected-projection", "incognito"])(
  "refuses chat.send until explicit workspace restore (%s)",
  { timeout: 90_000 },
  async (mode) => {
    const state = await createProductState("chat-explicit-restore-worktree");
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
    const incognito = mode === "incognito";
    const sessionKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}restore`;
    const workspaceStates: unknown[] = [];
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
          gateway: { auth: { mode: "token", token: "synthetic-explicit-restore-worktree" } },
        },
        configPath: state.configPath,
        token: "synthetic-explicit-restore-worktree",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent(event) {
          const payload = event.payload;
          if (!isRecord(payload) || payload.sessionKey !== sessionKey) {
            return;
          }
          if (event.event === "sessions.changed" && isRecord(payload.session)) {
            workspaceStates.push(payload.session.worktreeState);
          }
          if (event.event === "chat" && (payload.state === "error" || payload.state === "final")) {
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
          incognito,
          label: "Synthetic workspace restore",
          worktree: true,
          worktreeSource: "empty",
        },
      );
      await client.request("sessions.subscribe", {});
      const saved = path.join(created.worktree.path, "saved-task.txt");
      await fs.writeFile(saved, "saved work survives cleanup\n");
      expect(await client.request("worktrees.remove", { id: created.worktree.id })).toMatchObject({
        removed: true,
      });
      let uniqueFile: string | undefined;
      if (mode === "protected-projection") {
        await client.request("worktrees.restore", { id: created.worktree.id });
        using owner = await resolveLocalWorkspaceOwner({ cfg: {}, agentId: "main", sessionKey });
        if (!owner) {
          throw new Error("Created workspace has no projection owner");
        }
        const projection = await withLocalWorkspaceProjection(owner, (view) => view.prepare());
        uniqueFile = path.join(projection, "projection-only.txt");
        await fs.writeFile(uniqueFile, "unique projection bytes\n");
        expect(await client.request("sessions.describe", { key: sessionKey })).toMatchObject({
          session: { worktreeState: "ready" },
        });
        await fs.rm(created.worktree.path, { recursive: true });
      }
      if (mode === "fresh") {
        await updateRegistryWorktree(process.env, created.worktree.id, { snapshotRef: undefined });
      }
      await client.request("chat.send", {
        sessionKey,
        message: "Do not restore silently.",
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      expect(await failed.promise).toContain("This session's worktree was removed");
      expect(requests).toHaveLength(0);
      await expect(fs.access(saved)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await client.request("sessions.describe", { key: sessionKey })).toMatchObject({
        session: { worktreeState: mode === "fresh" ? "removed-fresh" : "removed-snapshot" },
      });
      expect(await client.request("sessions.list", { rowMode: "sidebar" })).toMatchObject({
        sessions: (incognito ? expect.not : expect).arrayContaining([
          expect.objectContaining({
            key: sessionKey,
            ...(!incognito && {
              worktreeState: mode === "fresh" ? "removed-fresh" : "removed-snapshot",
            }),
          }),
        ]),
      });
      await expect(client.request("sessions.diff", { sessionKey })).rejects.toThrow(
        "worktree was removed",
      );
      if (uniqueFile) {
        await expect(
          client.request("worktrees.restore", { id: created.worktree.id }),
        ).rejects.toThrow("local workspace projection");
        expect(await fs.readFile(uniqueFile, "utf8")).toBe("unique projection bytes\n");
        return;
      }
      workspaceStates.length = 0;
      using materialize = vi.spyOn(checkout, "materializeManagedWorktree");
      await Promise.all([
        client.request("worktrees.restore", { id: created.worktree.id }),
        client.request("worktrees.restore", { id: created.worktree.id }),
      ]);
      expect(materialize).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(workspaceStates).toContain("ready"));
      expect(await client.request("sessions.describe", { key: sessionKey })).toMatchObject({
        session: { worktreeState: "ready" },
      });
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
      expect(failures).toEqual([]);
      if (mode !== "fresh") {
        expect(await fs.readFile(saved, "utf8")).toBe("saved work survives cleanup\n");
        expect(await client.request("sessions.diff", { sessionKey })).toMatchObject({
          files: expect.arrayContaining([expect.objectContaining({ path: "saved-task.txt" })]),
        });
      } else {
        await expect(fs.access(saved)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await client.request("worktrees.remove", { id: created.worktree.id });
      await updateRegistryWorktree(process.env, created.worktree.id, {
        snapshotRef: "refs/openclaw/snapshots/unavailable",
      });
      await expect(
        client.request("worktrees.restore", { id: created.worktree.id }),
      ).rejects.toThrow("snapshot-invalid");
      expect(requests).toHaveLength(1);
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "explicit worktree restore proof complete" });
      }
      await closeProvider(providerServer);
      vi.unstubAllEnvs();
      await state.cleanup();
    }
  },
);
