import { expect, it, vi, type Mock } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { resolvePreparedSandboxRuntimeStatus } from "../../agents/sandbox/runtime-status.js";
import {
  createRuntimeConfigReader,
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as configuredOwners from "../../state/user-channel-identity-operations.js";
import {
  bindCommandOwnerAuthority,
  captureCommandOwnerAssertion,
} from "../command-owner-authority.js";
import type {
  AdmittedFollowupTurn,
  admitFollowupTurn as admitFollowupTurnImpl,
} from "./followup-turn-admission.js";
import type { FollowupRun } from "./queue/types.js";
import { resolveReplyToolAuthorityContext } from "./reply-tool-authority.js";

function resolveAdmittedToolAuthority(turn: AdmittedFollowupTurn) {
  const { run } = turn.queued;
  return resolveReplyToolAuthorityContext(
    turn.queued,
    undefined,
    resolvePreparedSandboxRuntimeStatus({
      cfg: run.config,
      agentId: run.agentId,
      sessionKey: run.sessionKey,
      preparedSessionEntry: turn.session.current() ?? null,
    }),
    {}, // These admission fixtures have no persisted parent capability lineage.
  );
}

export function createRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "queued prompt",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "queued-session",
      sessionKey: "main",
      sessionFile: "/tmp/queued.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  };
}

export function createOperation(sessionId = "queued-session") {
  return {
    sessionId,
    abortSignal: new AbortController().signal,
    setPhase: vi.fn(),
    abortForRestart: vi.fn(() => true),
    retainFailureUntilComplete: vi.fn(),
    fail: vi.fn(),
    complete: vi.fn(),
    updateSessionId: vi.fn(),
  };
}

export function createDefaults(overrides: Record<string, unknown> = {}) {
  return {
    typing: {} as never,
    typingMode: "never" as const,
    defaultModel: "claude",
    sessionKey: "main",
    ...overrides,
  };
}

export function registerFollowupOwnerPolicyCases({
  admitFollowupTurn,
  state,
}: {
  admitFollowupTurn: typeof admitFollowupTurnImpl;
  state: { admitReply: Mock; resolveConfig: Mock; preflight: Mock };
}): void {
  it.each([false, true])(
    "resolves owner privileges at the admission fence after enqueue owner=%s",
    async (enqueuedOwner) => {
      const queued = createRun();
      const originalConfig = {
        commands: { ownerAllowFrom: [enqueuedOwner ? "telegram:alice" : "telegram:other"] },
      };
      const admittedOwner = !enqueuedOwner;
      const admittedConfig = {
        commands: { ownerAllowFrom: [admittedOwner ? "telegram:alice" : "telegram:other"] },
      };
      const laterConfig = { ...admittedConfig, tools: { deny: ["message"] } };
      const operation = createOperation();
      const durableOwnerRead = vi
        .spyOn(configuredOwners, "prepareConfiguredCommandOwnerAuthority")
        .mockResolvedValue(undefined);
      setRuntimeConfigSnapshot(originalConfig, originalConfig);
      queued.run.config = originalConfig;
      queued.readAdmissionConfig = createRuntimeConfigReader(originalConfig);
      queued.run.requesterOrigin = {
        sessionKey: "agent:original:telegram:direct:alice",
        messageProvider: "telegram",
        accountId: "work",
        senderId: "alice",
      };
      queued.run.senderId = "receiver";
      queued.run.senderIsOwner = enqueuedOwner;
      queued.run.traceAuthorized = enqueuedOwner;
      bindCommandOwnerAuthority(queued.run, { isCurrent: () => enqueuedOwner });
      state.admitReply.mockImplementation(async ({ captureRunSelection }) => {
        // The actual admission owner invokes this fence again after waiting for a direct command.
        setRuntimeConfigSnapshot(admittedConfig, admittedConfig);
        captureRunSelection();
        setRuntimeConfigSnapshot(laterConfig, laterConfig);
        return { status: "owned", operation };
      });
      try {
        const result = await admitFollowupTurn({ queued, defaults: createDefaults() });
        expect(result.kind).toBe("admitted");
        if (result.kind !== "admitted") {
          throw new Error("Expected the original input to receive a new execution");
        }
        const execution = result.turn.queued;
        expect(execution.run.config).toEqual(admittedConfig);
        expect(execution.run.senderIsOwner).toBe(admittedOwner);
        expect(execution.run.traceAuthorized).toBe(admittedOwner);
        expect(resolveAdmittedToolAuthority(result.turn).capabilityProfile.sender.isOwner).toBe(
          admittedOwner,
        );
        const assertOwner = captureCommandOwnerAssertion(execution.run);
        if (admittedOwner) {
          expect(assertOwner).toBeDefined();
          expect(assertOwner).not.toThrow();
          setRuntimeConfigSnapshot({ commands: { ownerAllowFrom: [] } });
          expect(assertOwner).toThrow("Channel operator authority changed");
        } else {
          expect(assertOwner).toThrow("Channel operator authority changed");
        }
        expect(queued.run.senderIsOwner).toBe(enqueuedOwner);
        expect(queued.run.config).toBe(originalConfig);
      } finally {
        durableOwnerRead.mockRestore();
        clearRuntimeConfigSnapshot();
      }
    },
  );

  it("does not refresh queued owner policy past revoked operator custody", async () => {
    const queued = createRun();
    const controller = new AbortController();
    queued.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "alice",
      scopes: ["operator.admin"],
      assertCurrent: () => controller.signal.throwIfAborted(),
      signal: controller.signal,
    });
    queued.run.requesterOrigin = {
      sessionKey: "main",
      messageProvider: "telegram",
      senderId: "alice",
    };
    queued.run.senderIsOwner = true;
    const operation = createOperation();
    state.admitReply.mockResolvedValue({ status: "owned", operation });
    state.resolveConfig.mockImplementation(async (config) => {
      controller.abort(new Error("operator source retired"));
      return config;
    });
    await expect(admitFollowupTurn({ queued, defaults: createDefaults() })).rejects.toThrow(
      "operator source retired",
    );
    expect(state.admitReply).toHaveBeenCalledOnce();
    expect(operation.complete).toHaveBeenCalledOnce();
    expect(state.preflight).not.toHaveBeenCalled();
  });

  it("retains live operator admin precedence over external channel owner policy", async () => {
    const queued = createRun();
    const assertCurrent = vi.fn();
    queued.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "alice-profile",
      scopes: ["operator.admin"],
      assertCurrent,
    });
    queued.run.requesterOrigin = {
      sessionKey: "agent:original:telegram:direct:alice",
      messageProvider: "telegram",
      senderId: "alice",
      operatorProfileId: "alice-profile",
    };
    queued.run.config = { commands: { ownerAllowFrom: ["telegram:other"] } };
    queued.run.senderIsOwner = true;
    queued.run.traceAuthorized = true;
    state.admitReply.mockResolvedValue({ status: "owned", operation: createOperation() });
    const durableOwnerRead = vi
      .spyOn(configuredOwners, "prepareConfiguredCommandOwnerAuthority")
      .mockResolvedValue(undefined);
    try {
      const result = await admitFollowupTurn({ queued, defaults: createDefaults() });
      expect(result.kind).toBe("admitted");
      if (result.kind !== "admitted") {
        throw new Error("Expected operator input admission");
      }
      expect(result.turn.queued.run.senderIsOwner).toBe(true);
      expect(result.turn.queued.run.traceAuthorized).toBe(true);
      expect(resolveAdmittedToolAuthority(result.turn).capabilityProfile.sender.isOwner).toBe(true);
      expect(assertCurrent).toHaveBeenCalled();
      expect(durableOwnerRead).not.toHaveBeenCalled();
    } finally {
      durableOwnerRead.mockRestore();
    }
  });
}
