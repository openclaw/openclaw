import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { requireGit } from "../agents/worktrees/git.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setLoggerOverride } from "../logging.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  onceMessage,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { initializeRepository } from "./server.sessions.create.projects.test-support.js";
import { setupSessionCreateHandlerTestHarness } from "./server.sessions.create.test-support.js";
import { gatewayReplyMock, writeSessionStore } from "./test-helpers.js";
import { settleGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";
import { getGatewayConfigModule } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, withSessionTestState } = setupSessionCreateHandlerTestHarness();

test("a contributor creates, reads, and runs a required workspace on a non-main agent over the Gateway", async () => {
  // Revocation must commit through the reload owner; minimal Gateways retain startup policy.
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
  const config = await getGatewayConfigModule();
  // Keep real writes on the Gateway fixture's config path while isolating session state.
  const env = { OPENCLAW_CONFIG_PATH: config.CONFIG_PATH };
  await withSessionTestState({ layout: "state-only", env }, async (state) => {
    const workspace = await initializeRepository(state.root, "project");
    const main = await requireGit(workspace, ["rev-parse", "main"]);
    await requireGit(workspace, ["checkout", "-b", "unrelated-source"]);
    await requireGit(workspace, ["commit", "--allow-empty", "-m", "source ahead of main"]);
    testState.agentConfig = { workspace };
    // The canonical writer pins main when expanding the roster; keep the runtime override identical.
    testState.agentsConfig = {
      ownership: "explicit",
      entries: { main: { workspace }, "contributor-agent": {} },
    };
    const { dir, storePath } = await createSessionStoreDir();
    // Sync the store before startup so the first RPC does not rewrite the source config.
    await writeSessionStore({ entries: {}, storePath, agentId: "contributor-agent" });
    const project = await registerProjectRegistry({ path: workspace });
    const profile = ensureProfileForEmail("workspace-contributor@example.test");
    const origin = "https://control.example.test";
    const scopes = ["operator.sessions.read", "operator.sessions.write"] as const;
    const auth = {
      mode: "trusted-proxy" as const,
      trustedProxy: { userHeader: "x-forwarded-user", allowLoopback: true },
    };
    testState.gatewayAuth = auth;
    testState.gatewayControlUi = { allowedOrigins: [origin] };
    const cfg: OpenClawConfig = {
      gateway: {
        auth,
        trustedProxies: ["127.0.0.1"],
        controlUi: { allowedOrigins: [origin] },
        roles: {
          default: "contributor",
          definitions: {
            contributor: {
              sessions: {
                others: "view",
                workspace: { projects: [project.id], worktreeBaseRef: "main" },
              },
              agents: ["contributor-agent"],
              scopes: [...scopes],
            },
          },
        },
      },
    };
    const configIO = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
    // The reload owner must see the same fixture overrides in source and runtime.
    await configIO.writeConfigFile(config.applyConfigOverrides(cfg), { inputBase: "source" });
    await withGatewayServer(async ({ port, server }) => {
      await server.startupSettled;
      const headers = {
        origin,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        "x-forwarded-user": "workspace-contributor@example.test",
      };
      const connectOptions = {
        skipDefaultAuth: true,
        prePairDevice: true,
        client: CONTROL_UI_CLIENT,
        browserOrigin: origin,
        scopes: [...scopes],
        deviceIdentityPath: path.join(state.root, "contributor-device.sqlite"),
      };
      const ws = await openWs(port, headers);
      try {
        const connected = await connectReq(ws, connectOptions);
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        const created = await rpcReq<{
          key: string;
          entry: SessionEntry;
          worktree: { id: string; path: string };
        }>(ws, "sessions.create", { agentId: "contributor-agent", projectId: project.id });
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        const payload = created.payload!;
        expect(payload.key).toMatch(/^agent:contributor-agent:dashboard:/u);
        expect(await requireGit(payload.worktree.path, ["rev-parse", "HEAD"])).toBe(main);
        expect(
          loadSessionEntry({ agentId: "contributor-agent", sessionKey: payload.key, storePath }),
        ).toMatchObject({
          createdActor: { type: "human", source: "profile", id: profile.id },
          requiredWorkspace: { projectId: project.id, worktreeBaseRef: "main" },
          sessionRoot: payload.worktree.path,
        });
        const read = await rpcReq(ws, "sessions.get", { key: payload.key });
        expect(read.ok, JSON.stringify(read.error)).toBe(true);
        const runId = "required-workspace-turn";
        const replyText = "The selected workspace is ready.";
        // Keep the real dispatcher and delivery owner; control only the model reply source.
        gatewayReplyMock.mockResolvedValueOnce({ text: replyText });
        const terminal = onceMessage(
          ws,
          (frame) =>
            frame.type === "event" &&
            frame.event === "chat" &&
            frame.payload?.runId === runId &&
            frame.payload?.sessionKey === payload.key &&
            (frame.payload?.state === "final" ||
              frame.payload?.state === "error" ||
              frame.payload?.state === "aborted"),
        );
        void terminal.catch(() => undefined);
        const accepted = await rpcReq(ws, "chat.send", {
          sessionKey: payload.key,
          message: "inspect the selected workspace",
          idempotencyKey: runId,
        });
        expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
        expect(accepted.payload).toMatchObject({ runId, status: "started" });
        expect((await terminal).payload).toMatchObject({
          state: "final",
          message: {
            role: "assistant",
            content: expect.arrayContaining([{ type: "text", text: replyText }]),
          },
        });
        await settleGatewaySessionStoreFixture(dir);
        expect(gatewayReplyMock).toHaveBeenCalledOnce();
        expect(gatewayReplyMock.mock.calls[0]?.[0]).toMatchObject({ SessionKey: payload.key });
        expect(gatewayReplyMock.mock.calls[0]?.[1]).toMatchObject({ runId });

        const key = "agent:contributor-agent:dashboard:old-shared-thread";
        await upsertSessionEntryCore(
          { agentId: "contributor-agent", storePath, sessionKey: key },
          {
            sessionId: "old-shared-thread",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: profile.id },
            createdVia: "operator",
          },
        );
        const continued = await rpcReq(ws, "chat.send", {
          sessionKey: key,
          message: "must select a new workspace",
          idempotencyKey: "old-workspace-turn",
        });
        expect(continued).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        expect(gatewayReplyMock).toHaveBeenCalledOnce();
        const invalidated = new Promise<{ code: number; reason: string }>((resolve) => {
          ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
        });
        const prepared = await configIO.readConfigFileSnapshotForWrite();
        expect(prepared.snapshot.valid, JSON.stringify(prepared.snapshot.issues)).toBe(true);
        expect(prepared.snapshot.sourceConfig.agents?.entries?.main?.workspace).toBe(workspace);
        expect(config.getRuntimeConfig().agents?.entries?.main?.workspace).toBe(workspace);
        // Edit the source policy only; runtime defaults require unrelated service reloads.
        const revokedConfig = structuredClone(prepared.snapshot.sourceConfig);
        expectDefined(
          revokedConfig.gateway?.roles?.definitions.contributor?.sessions.workspace,
          "contributor workspace",
        ).projects = [];
        const application = createRuntimeConfigWriteApplication();
        // The harness silences both sinks; retain the real reload owner's failure reason.
        setLoggerOverride({ level: "silent", consoleLevel: "info" });
        try {
          await configIO.writeConfigFile(
            revokedConfig,
            attachRuntimeConfigWriteApplication(
              {
                ...prepared.writeOptions,
                baseSnapshot: prepared.snapshot,
                inputBase: "source" as const,
              },
              application,
            ),
          );
          expect(application.claimed).toBe(true);
          expect(await application.result).toBe("applied");
        } finally {
          setLoggerOverride({ level: "silent", consoleLevel: "silent" });
        }
        expect(await invalidated).toEqual({
          code: 4001,
          reason: "gateway policy changed",
        });
        expect(gatewayReplyMock).toHaveBeenCalledOnce();
        const reconnected = await openWs(port, headers);
        try {
          const reconnect = await connectReq(reconnected, connectOptions);
          expect(reconnect.ok, JSON.stringify(reconnect.error)).toBe(true);
          const revoked = await rpcReq(reconnected, "chat.send", {
            sessionKey: payload.key,
            message: "project access revoked",
            idempotencyKey: "revoked-project-turn",
          });
          expect(revoked).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
          expect(gatewayReplyMock).toHaveBeenCalledOnce();
        } finally {
          reconnected.close();
        }
      } finally {
        ws.close();
      }
    });
  });
});
