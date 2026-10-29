import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import type { SystemAgentApprovalRequestPayload } from "../infra/system-agent-approvals.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "../state/openclaw-state-db-cache.js";
import { SystemAgentChatEngine } from "../system-agent/chat-engine.js";
import * as setupInference from "../system-agent/setup-inference.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  createSystemAgentPluginMetadataTestSnapshot,
} from "../system-agent/system-agent.test-helpers.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./server-methods/system-agent.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

export function registerGatewayToolFinalEffectTests() {
  describe("Gateway-built tool final effects", () => {
    const tempDirs = useAutoCleanupTempDirTracker(afterEach);
    afterEach(async () => {
      await closeOpenClawStateDatabaseAsync();
      vi.restoreAllMocks();
      resetAgentRunRegistryForTest();
      resetPluginStateStoreForTests();
      resetCommandQueueStateForTest();
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      vi.unstubAllEnvs();
    });

    async function fixture(workspaceOnly?: boolean) {
      const stateDir = tempDirs.make("openclaw-gateway-effects-");
      const configPath = path.join(stateDir, "openclaw.json");
      const workspaceDir = path.join(stateDir, "task");
      await fs.mkdir(workspaceDir);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "openai/gpt-5.5@openai:verified" } },
        auth: { profiles: { "openai:verified": { provider: "openai", mode: "api_key" } } },
        tools: {
          allow: ["openclaw", "view_image"],
          ...(workspaceOnly === undefined ? {} : { fs: { workspaceOnly } }),
        },
      };
      const original = JSON.stringify(cfg);
      await fs.writeFile(configPath, original);
      setRuntimeConfigSnapshot(cfg);
      const metadata = createSystemAgentPluginMetadataTestSnapshot(cfg);
      const inference = await metadata.run(() =>
        createSystemAgentVerifiedInferenceTestFixture(cfg),
      );
      // Only the external inference selection is fixed; approval and config persistence stay real.
      vi.spyOn(setupInference, "resolvePersistentApplyInference").mockResolvedValue(
        inference.binding.execution,
      );
      const engine = new SystemAgentChatEngine({
        operatorApprovalOnly: true,
        surface: "gateway",
        verifiedInference: inference.binding,
        runAgentTurn: async () => ({ text: "Config verified." }),
      });
      const session: SystemAgentChatSession = {
        engine,
        welcome: "fixture",
        lastUsedAt: 1,
        ownerKey: JSON.stringify(["main", "agent:main:effects"]),
      };
      const sessions = new Map([["delegate-effects", session]]);
      const databasePath = path.join(stateDir, "approvals.sqlite");
      const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
        scheduler: createTestGatewayScheduler(),
        approvalKind: "system-agent",
        resolveAllowedDecisions: (request) => request.allowedDecisions,
        validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
        persistence: { runtimeEpoch: "gateway-effects", databaseOptions: { path: databasePath } },
      });
      const requested = createDeferred();
      let requestCount = 0;
      const registry = createRequestGatewayMethodRegistry(systemAgentHandlers);
      const context = {
        systemAgentSessions: sessions,
        systemAgentApprovalManager: manager,
        getRuntimeConfig: () => cfg,
        getGatewayMethodRegistry: () => registry,
        trackExecution: <T>(run: () => Promise<T>) => run(),
        broadcast: (event: string) => {
          if (event === "openclaw.approval.requested") {
            requestCount++;
            requested.resolve();
          }
        },
        broadcastToConnIds: () => undefined,
        hasExecApprovalClients: () => true,
      } as unknown as GatewayRequestContext;
      const operationalRunInstance = createOperationalRunInstanceRef("gateway-effects");
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const tools = await metadata.run(() =>
        resolveGatewayScopedTools({
          cfg,
          sessionKey: "agent:main:effects",
          surface: "loopback",
          senderIsOwner: true,
          workspaceDir,
          agentDir: path.join(stateDir, "agent"),
          modelHasVision: true,
        }),
      );
      const delegate = tools.tools.find((tool) => tool.name === "openclaw");
      const image = tools.tools.find((tool) => tool.name === "view_image");
      assert(delegate && image);
      const call = (signal?: AbortSignal) =>
        metadata.run(() =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: "agent:main:effects",
              operationalRunInstance,
              approvalAuthority: authority,
              receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
              gatewayContextResolver: () => context,
            },
            () =>
              delegate.execute(
                "config-change",
                { sessionId: "delegate-effects", message: "config set logging.level debug" },
                signal,
              ),
          ),
        );
      return {
        stateDir,
        workspaceDir,
        configPath,
        original,
        image,
        manager,
        requested,
        authority,
        call,
        execution: inference.binding.execution,
        requestCount: () => requestCount,
        close: async () => {
          for (const record of await manager.listPendingRecords()) {
            await manager.expire(record.id);
          }
          await manager.drain();
          await engine.dispose();
          await closeOpenClawStateDatabaseByPathAsync(databasePath);
        },
      };
    }

    it.each([undefined, false])(
      "persists permitted Gateway delegation with workspaceOnly=%s without approval",
      async (workspaceOnly) => {
        const f = await fixture(workspaceOnly);
        try {
          const result = await f.call();
          expect(result.details).toMatchObject({
            reply: expect.stringContaining("[openclaw] done: config.set"),
          });
          expect(JSON.parse(await fs.readFile(f.configPath, "utf8"))).toMatchObject({
            logging: { level: "debug" },
          });
          expect(await f.manager.listPendingRecords()).toEqual([]);
          expect(f.requestCount()).toBe(0);
        } finally {
          await f.close();
        }
      },
    );

    it.each(["approve", "tool-cancelled", "run-revoked", "precommit-revoked"] as const)(
      "fences workspace-restricted persistent Gateway delegation: %s",
      async (outcome) => {
        const f = await fixture(true);
        const controller = new AbortController();
        const applyStarted = createDeferred();
        const releaseApply = createDeferred();
        let pending: ReturnType<typeof f.call> | undefined;
        try {
          pending = f.call(controller.signal);
          // Observe settlement too: on the broken factory the forbidden write completes instead of requesting approval.
          expect(
            await Promise.race([
              f.requested.promise.then(() => "approval"),
              pending.then(() => "completed"),
            ]),
          ).toBe("approval");
          expect(await fs.readFile(f.configPath, "utf8")).toBe(f.original);
          const [record] = await f.manager.listPendingRecords();
          assert(record);
          // Pause external inference preparation, not the approval owner or persistent sink.
          if (outcome === "precommit-revoked") {
            const execution = f.execution;
            vi.mocked(setupInference.resolvePersistentApplyInference).mockImplementationOnce(
              async () => {
                applyStarted.resolve();
                await releaseApply.promise;
                return execution;
              },
            );
          }
          if (outcome === "tool-cancelled") {
            controller.abort();
          } else if (outcome === "run-revoked") {
            releaseAgentRunDelegatedAuthority(f.authority);
            await f.manager.forceDenyIfRuntimeAuthorityClosed(record.id);
          } else {
            expect(await f.manager.resolve(record.id, "allow-once", "fixture-operator")).toBe(true);
            if (outcome === "precommit-revoked") {
              await applyStarted.promise;
              releaseAgentRunDelegatedAuthority(f.authority);
              releaseApply.resolve();
            }
          }
          const result = await pending.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          if (outcome === "approve") {
            expect(result).toHaveProperty("value");
            expect(JSON.parse(await fs.readFile(f.configPath, "utf8"))).toMatchObject({
              logging: { level: "debug" },
            });
          } else {
            expect(await fs.readFile(f.configPath, "utf8")).toBe(f.original);
            expect((await f.manager.getSnapshot(record.id))?.status).toBe(
              outcome === "precommit-revoked" ? "allowed" : "cancelled",
            );
            expect(await f.manager.resolve(record.id, "allow-once", "late-operator")).toBe(false);
            expect(await fs.readFile(f.configPath, "utf8")).toBe(f.original);
          }
        } finally {
          releaseApply.resolve();
          controller.abort();
          await pending?.catch(() => undefined);
          await f.close();
        }
      },
    );

    it("reads workspace media through Gateway-built tools but denies an outside default-root image", async () => {
      const f = await fixture(true);
      try {
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/BsAAAAASUVORK5CYII=",
          "base64",
        );
        const inside = path.join(f.workspaceDir, "inside.png");
        const outside = path.join(f.stateDir, "canvas", "outside.png");
        await fs.mkdir(path.dirname(outside));
        await Promise.all([inside, outside].map((file) => fs.writeFile(file, png)));
        const result = await f.image.execute("inside", { path: inside });
        expect(result.content).toContainEqual(
          expect.objectContaining({
            type: "image",
            mimeType: "image/png",
            data: png.toString("base64"),
          }),
        );
        await expect(f.image.execute("outside", { path: outside })).rejects.toThrow(
          /not under an allowed directory/i,
        );
      } finally {
        await f.close();
      }
    });
  });
}
