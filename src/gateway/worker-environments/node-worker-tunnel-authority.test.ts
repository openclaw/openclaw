import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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

function pendingWorkspaceBinding(record = environment(), transfer = workspaceTransfer()) {
  const binding = createDeferred<undefined>();
  const resolving = createDeferred();
  const manager = createManager(record, { workspaceTransfer: transfer });
  const resolveBinding = vi.fn(async () => {
    resolving.resolve();
    return await binding.promise;
  });
  manager.bindWorkspaceBindingResolver(resolveBinding);
  return { manager, binding, resolving, resolveBinding };
}

describe("node worker tunnel source authority", () => {
  it.each(["start", "session-command", "aborted-session-command"] as const)(
    "does not expose a tunnel after %s authority closes during workspace binding",
    async (operation) => {
      const record = { ...environment(), sharedHost: false };
      const prepareSync = vi.fn();
      const { manager, binding, resolving } = pendingWorkspaceBinding(
        record,
        workspaceTransfer({ prepareSync }),
      );
      let authorized = true;
      const controller = new AbortController();
      const authorize = () => {
        if (!authorized) {
          throw new Error("session dispatch authority closed");
        }
      };
      const starting =
        operation === "start"
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
        await resolving.promise;
        if (operation === "aborted-session-command") {
          controller.abort(new Error("session dispatch authority closed"));
        } else {
          authorized = false;
        }
        binding.resolve(undefined);

        await expect(starting).rejects.toThrow("session dispatch authority closed");
        expect(prepareSync).not.toHaveBeenCalled();
        expect(manager.status(record.environmentId)).toBe("stopped");
      } finally {
        binding.resolve(undefined);
        await starting.catch(() => undefined);
        await manager.stop(record.environmentId, record.ownerEpoch);
      }
    },
  );

  it("joins same-owner starts while workspace binding resolution is pending", async () => {
    const record = environment();
    const { manager, binding, resolving, resolveBinding } = pendingWorkspaceBinding(record);

    const first = manager.start(startRequest());
    await resolving.promise;
    const second = manager.start(startRequest());
    let authorized = true;
    const closed = new Error("joining source closed");
    const authorize = () => {
      if (!authorized) {
        throw closed;
      }
    };
    const joining = manager.start({ ...startRequest(), authorize });
    const rejected = expect(joining).rejects.toBe(closed);
    authorized = false;
    binding.resolve(undefined);

    try {
      const [firstHandle, secondHandle] = await Promise.all([first, second]);
      await rejected;
      expect(resolveBinding).toHaveBeenCalledOnce();
      expect(secondHandle).toBe(firstHandle);
      await expect(manager.start({ ...startRequest(), authorize })).rejects.toBe(closed);
      expect(manager.status(record.environmentId)).toBe("connected");
    } finally {
      await Promise.allSettled([first, second, joining]);
      await manager.stop(record.environmentId, record.ownerEpoch);
    }
  });
});

describe("node worker tunnel workspace command deadline", () => {
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
      try {
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
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
});
