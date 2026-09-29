// Covers the delegated run fence between reviewer resolution and the final effect.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type {
  SystemAgentApprovalRequestPayload,
  SystemAgentApprovalResolved,
} from "../../infra/system-agent-approvals.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ChatTurnRouter } from "../../system-agent/chat-turn-router.js";
import { ChatWizardHost } from "../../system-agent/chat-wizard-host.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { queueDelegatedApproval } from "./system-agent-approval.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import type { GatewayRequestContext } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  resetAgentRunRegistryForTest();
  vi.unstubAllEnvs();
});

function createRealConfigSession(operation: { kind: "config-set"; path: string; value: string }) {
  const router = new ChatTurnRouter(
    { operatorApprovalOnly: true },
    {},
    {
      sessionId: "delegated-config-session",
      verifiedInference: {},
      proposalRef: {},
    } as never,
    new ChatWizardHost({ beforePersistentApply: async () => {} }),
    {
      requireVerifiedInference: async () => undefined,
      requirePersistentApplyInference: async () => undefined,
      rebindVerifiedInference: () => {},
      getVerifiedInference: () => ({}) as never,
      loadOverview: async () => ({}) as never,
      getHistory: () => [],
      verifyConfigAfterWrite: async () => null,
    },
  );
  router.propose(operation);
  const proposal = router.getPendingOperatorProposal();
  if (!proposal) {
    throw new Error("expected delegated config proposal");
  }
  const session = {
    engine: {
      getPendingOperatorProposal: () => router.getPendingOperatorProposal(),
      resolveOperatorApproval: (
        decision: "allow-once" | "allow-always" | "deny" | null,
        proposalHash: string,
        beforePersistentApply?: () => void,
      ) => router.resolveOperatorApproval(decision, proposalHash, beforePersistentApply),
    },
    welcome: "",
    lastUsedAt: 1,
    ownerKey: "agent:main:main",
  } as unknown as SystemAgentChatSession;
  return { proposal, session };
}

describe("queueDelegatedApproval authority", () => {
  it.each([
    {
      name: "allowed reviewer on the root config",
      decision: "allow-once" as const,
      revokeAtAuthorityCheck: undefined,
      target: "root" as const,
    },
    {
      name: "denied reviewer on the root config",
      decision: "deny" as const,
      revokeAtAuthorityCheck: undefined,
      target: "root" as const,
    },
    {
      name: "revoked run on the root config",
      decision: "allow-once" as const,
      revokeAtAuthorityCheck: 3,
      target: "root" as const,
    },
    {
      name: "allowed reviewer on an included config",
      decision: "allow-once" as const,
      revokeAtAuthorityCheck: undefined,
      target: "include" as const,
    },
    {
      name: "revoked run on an included config",
      decision: "allow-once" as const,
      revokeAtAuthorityCheck: 3,
      target: "include" as const,
    },
  ])(
    "carries $name through the production config route to final file effects",
    async ({ decision, revokeAtAuthorityCheck, target }) => {
      const stateDir = tempDirs.make("openclaw-gateway-config-approval-");
      const configPath = path.join(stateDir, "openclaw.json");
      const includePath = path.join(stateDir, "tools.json5");
      const initialConfig =
        target === "root"
          ? '{"tools":{"exec":{"notifyOnExit":true}}}\n'
          : '{"tools":{"$include":"./tools.json5"}}\n';
      const initialInclude = '{"exec":{"notifyOnExit":true}}\n';
      const initialBackup = "preexisting-backup\n";
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      await fs.writeFile(configPath, initialConfig);
      const mutationPath = target === "root" ? configPath : includePath;
      if (target === "include") {
        if (process.platform !== "win32") {
          await fs.chmod(stateDir, 0o755);
        }
        await fs.writeFile(includePath, initialInclude);
      }
      await fs.writeFile(`${mutationPath}.bak`, initialBackup);
      const operation =
        target === "root"
          ? { kind: "config-set" as const, path: "tools.exec.notifyOnExit", value: "false" }
          : { kind: "config-set" as const, path: "tools.exec.notifyOnExit", value: "false" };
      const { proposal, session } = createRealConfigSession(operation);
      const sessions = new Map([["delegated-config-session", session]]);
      const operationalRunInstance = {
        instanceId: `config-${decision}-instance`,
        runId: `config-${decision}-run`,
      };
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      let authorityChecks = 0;
      const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
        approvalKind: "system-agent",
        resolveAllowedDecisions: (request) => request.allowedDecisions,
        validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      });
      const applicationResult = createDeferredCore<SystemAgentApprovalResolved>();
      const publishResolved = vi.fn((_approvalKind: string, event: SystemAgentApprovalResolved) => {
        applicationResult.resolve(event);
      });
      const context = {
        systemAgentApprovalManager: manager,
        approvalEvents: { publishRequested: vi.fn(() => 1), publishResolved },
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
        hasExecApprovalClients: () => true,
      } as unknown as GatewayRequestContext;

      const approvalId = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance,
          receiptAuthority: () => {
            authorityChecks += 1;
            if (authorityChecks === revokeAtAuthorityCheck) {
              releaseAgentRunDelegatedAuthority(authority);
              return false;
            }
            return true;
          },
        },
        () =>
          queueDelegatedApproval({
            context,
            sessions,
            session,
            sessionId: "delegated-config-session",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
          }),
      );

      expect(manager.resolve(approvalId, decision, "operator-ui")).toBe(true);
      const expectedStatus =
        decision === "allow-once" && revokeAtAuthorityCheck === undefined && target === "root"
          ? "applied"
          : "not-applied";
      await expect(applicationResult.promise).resolves.toMatchObject({
        applicationStatus: expectedStatus,
      });
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: expectedStatus }),
      );

      if (expectedStatus === "applied") {
        if (target === "root") {
          expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
            tools: { exec: { notifyOnExit: false } },
          });
        } else {
          expect(await fs.readFile(configPath, "utf8")).toBe(initialConfig);
          expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toMatchObject({
            exec: { notifyOnExit: false },
          });
        }
        if (target === "root") {
          expect(await fs.readFile(`${mutationPath}.bak`, "utf8")).toBe(initialConfig);
          expect(await fs.readFile(`${mutationPath}.bak.1`, "utf8")).toBe(initialBackup);
        } else {
          expect(await fs.readFile(`${mutationPath}.bak`, "utf8")).toBe(initialBackup);
          await expect(fs.readFile(`${mutationPath}.bak.1`, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      } else {
        expect(await fs.readFile(configPath, "utf8")).toBe(initialConfig);
        if (target === "include") {
          expect(await fs.readFile(includePath, "utf8")).toBe(initialInclude);
        }
        expect(await fs.readFile(`${mutationPath}.bak`, "utf8")).toBe(initialBackup);
        await expect(fs.readFile(`${mutationPath}.bak.1`, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      if (target === "include" && process.platform !== "win32") {
        expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o755);
      }
      releaseAgentRunDelegatedAuthority(authority);
    },
    30_000,
  );

  it("blocks the persistent effect when its delegated run closes after review", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "a".repeat(64),
    };
    const persistentEffect = vi.fn();
    const resolveOperatorApproval = vi.fn(
      async (
        _decision: "allow-once" | "allow-always" | "deny" | null,
        _proposalHash: string,
        beforePersistentApply?: () => void,
      ) => {
        beforePersistentApply?.();
        persistentEffect();
        return { text: "Applied", action: "none" as const };
      },
    );
    const session = {
      engine: { getPendingOperatorProposal: () => proposal, resolveOperatorApproval },
      welcome: "",
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegated-session", session]]);
    const operationalRunInstance = {
      instanceId: "delegated-approval-instance",
      runId: "delegated-approval-run",
    };
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    let receiptAuthorityChecks = 0;
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    const context = {
      systemAgentApprovalManager: manager,
      approvalEvents: { publishRequested: vi.fn(() => 1), publishResolved },
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      hasExecApprovalClients: () => true,
    } as unknown as GatewayRequestContext;

    const approvalId = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
        receiptAuthority: () => {
          receiptAuthorityChecks += 1;
          if (receiptAuthorityChecks === 1) {
            return true;
          }
          releaseAgentRunDelegatedAuthority(authority);
          return false;
        },
      },
      () =>
        queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegated-session",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        }),
    );

    expect(manager.resolve(approvalId, "allow-once", "operator-ui")).toBe(true);
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "not-applied" }),
      ),
    );
    expect(receiptAuthorityChecks).toBe(2);
    expect(resolveOperatorApproval).toHaveBeenCalledWith(
      "allow-once",
      proposal.hash,
      expect.any(Function),
    );
    expect(persistentEffect).not.toHaveBeenCalled();
  });

  it("replaces a same-proposal approval owned by a closed prior run", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "b".repeat(64),
    };
    const session = {
      engine: {
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval: vi.fn(async () => ({
          text: "Applied",
          action: "none" as const,
          applied: true,
        })),
      },
      welcome: "",
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegated-session", session]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const context = {
      systemAgentApprovalManager: manager,
      approvalEvents: { publishRequested: vi.fn(() => 1), publishResolved: vi.fn() },
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      hasExecApprovalClients: () => true,
    } as unknown as GatewayRequestContext;
    const firstRun = { instanceId: "first-instance", runId: "first-run" };
    const firstAuthority = claimAgentRunDelegatedAuthority(firstRun);
    const queue = (operationalRunInstance: { instanceId: string; runId: string }) =>
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:main", operationalRunInstance },
        () =>
          queueDelegatedApproval({
            context,
            sessions,
            session,
            sessionId: "delegated-session",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
          }),
      );

    const firstId = await queue(firstRun);
    releaseAgentRunDelegatedAuthority(firstAuthority);
    const secondRun = { instanceId: "second-instance", runId: "second-run" };
    const secondAuthority = claimAgentRunDelegatedAuthority(secondRun);
    const secondId = await queue(secondRun);

    expect(secondId).not.toBe(firstId);
    expect(session.pendingApproval).toEqual({ id: secondId, proposalHash: proposal.hash });
    expect(manager.getSnapshot(firstId)).toMatchObject({
      resolvedAtMs: expect.any(Number),
      terminalReason: "run-aborted",
    });
    expect(manager.getSnapshot(secondId)?.resolvedAtMs).toBeUndefined();
    releaseAgentRunDelegatedAuthority(secondAuthority);
  });

  it("publishes denied replies as not applied", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "c".repeat(64),
    };
    const resolveOperatorApproval = vi.fn(async () => ({
      text: "Denied. No change.",
      action: "none" as const,
      applied: false,
    }));
    const session = {
      engine: { getPendingOperatorProposal: () => proposal, resolveOperatorApproval },
      welcome: "",
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegated-session", session]]);
    const operationalRunInstance = { instanceId: "denied-instance", runId: "denied-run" };
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    const context = {
      systemAgentApprovalManager: manager,
      approvalEvents: { publishRequested: vi.fn(() => 1), publishResolved },
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      hasExecApprovalClients: () => true,
    } as unknown as GatewayRequestContext;
    const approvalId = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:main", operationalRunInstance },
      () =>
        queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegated-session",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        }),
    );

    expect(manager.resolve(approvalId, "deny", "operator-ui")).toBe(true);
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "not-applied" }),
      ),
    );
    expect(resolveOperatorApproval).toHaveBeenCalledWith(
      "deny",
      proposal.hash,
      expect.any(Function),
    );
    releaseAgentRunDelegatedAuthority(authority);
  });
});
