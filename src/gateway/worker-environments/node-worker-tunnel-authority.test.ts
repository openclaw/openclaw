import { afterEach, expect, it, vi } from "vitest";
import { createReadBarrier } from "../../infra/sqlite-readonly.test-support.js";
import type { NodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import {
  createManager,
  environment,
  startRequest,
  transport,
  withWorkspaceDrain,
  workspaceCommandPayload,
  workspaceSnapshot,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each(["start", "session-command", "aborted-session-command", "joining-start"] as const)(
  "revalidates %s authority across pending workspace binding",
  async (operation) => {
    const joining = operation === "joining-start";
    const record = { ...environment(), sharedHost: joining };
    const prepareSync = vi.fn();
    const binding = createReadBarrier();
    const manager = createManager(record, {
      workspaceTransfer: joining ? workspaceTransfer() : workspaceTransfer({ prepareSync }),
    });
    const resolveBinding = vi.fn(() => binding.hold(undefined));
    manager.bindWorkspaceBindingResolver(resolveBinding);
    let authorized = true;
    const controller = new AbortController();
    const closed = new Error("session dispatch authority closed");
    const authorize = () => {
      if (!authorized) {
        throw closed;
      }
    };
    const owners = joining ? [manager.start(startRequest())] : [];
    if (joining) {
      await binding.entered.promise;
      owners.push(manager.start(startRequest()));
    }
    const starting =
      operation === "start" || joining
        ? manager.start({ ...startRequest(), authorize })
        : manager.runSessionCommand(
            { ...startRequest(), sessionKey: "agent:main:session-1" },
            {
              argv: ["pwd"],
              transportRetry: "never",
              assertCurrent: authorize,
              signal: controller.signal,
            },
          );
    try {
      await binding.entered.promise;
      if (operation === "aborted-session-command") {
        controller.abort(closed);
      } else {
        authorized = false;
      }
      binding.resume.resolve();

      if (joining) {
        await expect(starting).rejects.toBe(closed);
        const [first, second] = await Promise.all(owners);
        expect(resolveBinding).toHaveBeenCalledOnce();
        expect(second).toBe(first);
        await expect(manager.start({ ...startRequest(), authorize })).rejects.toBe(closed);
      } else {
        await expect(starting).rejects.toThrow(closed.message);
        expect(prepareSync).not.toHaveBeenCalled();
      }
      expect(manager.status(record.environmentId)).toBe(joining ? "connected" : "stopped");
    } finally {
      binding.resume.resolve();
      await Promise.allSettled([...owners, starting]);
      await manager.stop(record.environmentId, record.ownerEpoch);
    }
  },
);

it.each([300_000, -300_000])(
  "keeps idempotent retries on the monotonic budget across a %i ms wall-clock step",
  async (stepMs) => {
    const wallNow = Date.now.bind(Date);
    const snapshot = workspaceSnapshot("/gateway/workspace");
    const nodeTransport = transport();
    const timeouts: number[] = [];
    nodeTransport.invoke = withWorkspaceDrain(async (request) => {
      if ((request.params as NodeWorkerWorkspaceExecInput).argv[0] === "probe") {
        timeouts.push(request.timeoutMs ?? Number.NaN);
        if (timeouts.length === 1) {
          vi.spyOn(Date, "now").mockImplementation(() => wallNow() + stepMs);
          return { ok: false, error: { code: "DISCONNECTED" } };
        }
      }
      return { ok: true, payloadJSON: workspaceCommandPayload("/node/workspace") };
    });
    const manager = createManager(environment(), {
      getTransport: () => nodeTransport,
      workspaceTransfer: workspaceTransfer({
        prepareSync: vi.fn(async () => ({ snapshot, token: "restore-token" })),
      }),
    });
    manager.bindWorkspaceBindingResolver(async () => ({
      source: { kind: "local" as const, path: "/gateway/workspace" },
      manifestRef: snapshot.manifestRef,
      remoteWorkspaceDir: "/node/workspace",
    }));
    const handle = await manager.start(startRequest());
    await expect(
      handle.runWorkspaceCommand({
        argv: ["probe"],
        timeoutMs: 30_000,
        transportRetry: "idempotent",
      }),
    ).resolves.toMatchObject({ code: 0 });
    expect(timeouts).toHaveLength(2);
    expect(timeouts[1]).toBeLessThanOrEqual(timeouts[0] ?? 0);
  },
);
