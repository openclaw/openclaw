import { afterEach, describe, expect, it } from "vitest";
import { __testing, handleAcpInvokeCommand } from "./invoke-acp.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";

afterEach(() => {
  __testing.resetNodeAcpSessionsForTests();
});

function buildFrame(params: {
  command: string;
  nodeId?: string;
  payload: Record<string, unknown>;
}): NodeInvokeRequestPayload {
  return {
    id: "invoke-1",
    nodeId: params.nodeId ?? "node-1",
    command: params.command,
    paramsJSON: JSON.stringify(params.payload),
  };
}

describe("handleAcpInvokeCommand", () => {
  it("tracks ensured sessions, turn status, cancel, and close over the ACP command set", async () => {
    const ensured = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.ensure",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
          agent: "main",
          mode: "persistent",
          cwd: "/workspace",
        },
      }),
    );
    expect(ensured).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        sessionKey: "agent:main:acp:test",
        leaseId: "lease-1",
        leaseEpoch: 1,
      },
    });

    const started = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.turn.start",
        payload: {
          sessionKey: "agent:main:acp:test",
          runId: "run-1",
          leaseId: "lease-1",
          leaseEpoch: 1,
          requestId: "req-1",
          mode: "prompt",
          text: "hello",
        },
      }),
    );
    expect(started).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        accepted: true,
        runId: "run-1",
      },
    });

    const runningStatus = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.status",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
        },
      }),
    );
    expect(runningStatus).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        state: "running",
        nodeId: "node-1",
        sessionKey: "agent:main:acp:test",
        leaseId: "lease-1",
        leaseEpoch: 1,
        nodeWorkerRunId: expect.any(String),
        nodeRuntimeSessionId: expect.any(String),
      },
    });

    const cancelled = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.turn.cancel",
        payload: {
          sessionKey: "agent:main:acp:test",
          runId: "run-1",
          leaseId: "lease-1",
          leaseEpoch: 1,
          reason: "abort",
        },
      }),
    );
    expect(cancelled).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        accepted: true,
      },
    });

    const cancellingStatus = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.status",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
        },
      }),
    );
    expect(cancellingStatus).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        state: "cancelling",
      },
    });

    const closed = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.close",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
          reason: "cleanup",
        },
      }),
    );
    expect(closed).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        accepted: true,
      },
    });

    const missingStatus = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.status",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
        },
      }),
    );
    expect(missingStatus).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        state: "missing",
      },
    });
  });

  it("aliases acp.session.load onto the ensured runtime session for the same lease", async () => {
    const ensured = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.ensure",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
          agent: "main",
          mode: "persistent",
        },
      }),
    );
    const ensuredRuntimeSessionId = (
      ensured as Extract<typeof ensured, { handled: true; ok: true }>
    ).payload as {
      nodeRuntimeSessionId: string;
    };

    const loaded = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.load",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
          agent: "main",
          mode: "persistent",
        },
      }),
    );
    expect(loaded).toMatchObject({
      handled: true,
      ok: true,
      payload: {
        nodeRuntimeSessionId: ensuredRuntimeSessionId.nodeRuntimeSessionId,
      },
    });
  });

  it("rejects stale lease epochs after a replacement ensure", async () => {
    await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.ensure",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-1",
          leaseEpoch: 1,
          agent: "main",
          mode: "persistent",
        },
      }),
    );
    await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.session.ensure",
        payload: {
          sessionKey: "agent:main:acp:test",
          leaseId: "lease-2",
          leaseEpoch: 2,
          agent: "main",
          mode: "persistent",
        },
      }),
    );

    const stale = await handleAcpInvokeCommand(
      buildFrame({
        command: "acp.turn.cancel",
        payload: {
          sessionKey: "agent:main:acp:test",
          runId: "run-1",
          leaseId: "lease-1",
          leaseEpoch: 1,
        },
      }),
    );
    expect(stale).toMatchObject({
      handled: true,
      ok: false,
      code: "INVALID_REQUEST",
    });
  });
});
