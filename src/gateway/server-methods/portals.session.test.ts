import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createGatewayPortalService } from "../portals/portal-service.js";
import { portalHandlers } from "./portals.js";

function fixture() {
  const binding = {
    sessionKey: "agent:main:preview",
    agentId: "main",
    sessionId: "conversation",
    environmentId: "attached",
    ownerEpoch: 1,
    generation: 1,
  };
  let dedicated = true;
  const actor = new AbortController();
  const attachment = new AbortController();
  const session = new AbortController();
  const qualification = new AbortController();
  const assertActor = () => actor.signal.throwIfAborted();
  const f = {
    binding,
    session,
    release: vi.fn(),
    close: vi.fn(async () => {}),
    touch: vi.fn(async () => {}),
    connect: vi.fn(async (assertCurrent?: () => void, touchAttachment?: () => Promise<void>) => {
      assertCurrent?.();
      await touchAttachment?.();
      assertCurrent?.();
      return new PassThrough();
    }),
    broadcast: vi.fn(),
    revokeActor: () => actor.abort(new Error("actor revoked")),
    resetSession: () => session.abort(new Error("session reset")),
    replaceAttachment: () => attachment.abort(new Error("attachment replaced")),
    unqualify: () => {
      dedicated = false;
      qualification.abort();
    },
  };
  const environments = {
    captureSessionAttachment: vi.fn(() => ({
      binding,
      assertCurrent: () => attachment.signal.throwIfAborted(),
      touch: f.touch,
    })),
    get: () => ({ ...binding, leaseId: "lease-one", nodeDeviceId: "node-one", sharedHost: false }),
    getDedicatedNodeLeaseSignal: () => (dedicated ? qualification.signal : undefined),
    openNodePortal: vi.fn(async () => ({ connect: f.connect, close: f.close })),
  };
  const service = createGatewayPortalService({ httpBindHosts: ["127.0.0.1"], httpServers: [] });
  const open = vi.spyOn(service, "open");
  onTestFinished(() => service.closeAll());
  const access = {
    target: binding,
    sandboxRequired: false,
    assertCurrent: assertActor,
    retainSession: () => ({
      signal: session.signal,
      assertCurrent: () => session.signal.throwIfAborted(),
      release: f.release,
    }),
  };
  const invoke = async (
    action: "open" | "list" | "close",
    params: Record<string, unknown> = {},
    admitted = true,
  ) => {
    const respond = vi.fn();
    await portalHandlers[`portal.session.${action}`]!({
      params: { sessionKey: binding.sessionKey, environmentId: binding.environmentId, ...params },
      respond,
      context: {
        workerEnvironmentService: environments,
        portalService: service,
        broadcast: f.broadcast,
      },
      ...(admitted ? { sessionAccessAuthority: access } : {}),
      sessionMutationCommitGuard: assertActor,
    } as never);
    return respond.mock.calls[0];
  };
  return { ...f, service, open, environments, invoke };
}

describe("session-scoped attached worker portals", () => {
  it.each([
    { kind: "worker", retire: "resetSession" },
    { kind: "worker", retire: "unqualify" },
    { kind: "local", retire: "resetSession" },
  ] as const)(
    "keeps a global $kind portal and its credentials separate through $retire",
    async ({ kind, retire }) => {
      const f = fixture();
      const closeGlobal = vi.fn();
      const global = await f.service.open({
        targetPort: 3000,
        target:
          kind === "worker"
            ? {
                kind: "worker",
                environmentId: "attached",
                ownerEpoch: 1,
                remotePort: 3000,
                connect: f.connect,
              }
            : undefined,
        onClose: kind === "worker" ? closeGlobal : undefined,
      });
      expect((await f.invoke("open", { port: 3000 }))?.[0]).toBe(true);
      const scoped = f.service.list().find((portal) => portal.id !== global.id)!;
      expect(scoped.url).not.toBe(global.url);
      expect((await f.invoke("list"))?.[1]).toEqual({ portals: [scoped] });
      expect((await f.invoke("close", { id: global.id }))?.[0]).toBe(false);
      if (kind === "local") {
        expect(f.service.listWorkerPortals("attached", 1)).toEqual([scoped]);
      }
      const payload = f.broadcast.mock.calls[0]?.[1] as { portals: Record<string, unknown>[] };
      expect(payload.portals).toHaveLength(2);
      for (const summary of payload.portals) {
        expect(summary).not.toHaveProperty("url");
        expect(summary).not.toHaveProperty("tokenQuery");
        expect(summary).not.toHaveProperty("resourceOwnerKey");
      }
      expect((await f.invoke("open", { port: 3000 }))?.[1]).toEqual(scoped);
      expect(f.service.list()).toHaveLength(2);
      // Reuse releases only the unused new carrier, leaving both original resources owned.
      expect(f.close).toHaveBeenCalledOnce();
      expect(closeGlobal).not.toHaveBeenCalled();
      f[retire]();
      expect(f.service.list()).toEqual([global]);
      await f.service.close(scoped.id);
      expect(f.close).toHaveBeenCalledTimes(2);
      expect(f.release).toHaveBeenCalledTimes(2);
      expect(closeGlobal).not.toHaveBeenCalled();
      await f.service.close(global.id);
      expect(closeGlobal).toHaveBeenCalledTimes(kind === "worker" ? 1 : 0);
    },
  );

  it("allocates a distinct scoped resource when the attachment generation changes", async () => {
    const f = fixture();
    await f.invoke("open", { port: 3000 });
    const first = f.service.list()[0]!;
    f.binding.generation++;
    await f.invoke("open", { port: 3000 });
    const next = f.service.list().find((portal) => portal.id !== first.id)!;
    expect(next.url).not.toBe(first.url);
    expect((await f.invoke("list"))?.[1]).toEqual({ portals: [next] });
    // Environment teardown still finds every scoped prefix and the legacy worker suffix.
    await f.service.closeWorkerPortals("attached", 1);
    expect(f.service.list()).toEqual([]);
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing admission", undefined],
    ["different environment", undefined],
    ["not dedicated", undefined],
    ["actor revoked", "revokeActor"],
    ["session reset", "resetSession"],
    ["attachment replaced", "replaceAttachment"],
  ] as const)(
    "rejects %s before publishing a portal and releases any prepared carrier",
    async (reason, retire) => {
      const f = fixture();
      const entered = createDeferred();
      const finish = createDeferred();
      if (retire) {
        f.environments.openNodePortal.mockImplementationOnce(async () => {
          entered.resolve();
          await finish.promise;
          return { close: f.close, connect: f.connect };
        });
      } else if (reason === "not dedicated") {
        f.unqualify();
      }
      const opening = f.invoke(
        "open",
        {
          port: 3000,
          ...(reason === "different environment" ? { environmentId: "other" } : {}),
        },
        reason !== "missing admission",
      );
      if (retire) {
        await entered.promise;
        f[retire]();
        finish.resolve();
      }
      const response = await opening;
      expect(response?.[0]).toBe(false);
      if (reason === "session reset") {
        expect(response?.[2]).toMatchObject({ message: "session reset" });
      }
      for (const prepared of [f.environments.openNodePortal, f.close, f.release]) {
        expect(prepared).toHaveBeenCalledTimes(retire ? 1 : 0);
      }
      expect(f.service.list()).toEqual([]);
      expect(f.open).not.toHaveBeenCalled();
      expect(f.broadcast).not.toHaveBeenCalled();
    },
  );

  it("retains bearer resource authority after actor revocation until attachment or session retirement", async () => {
    const f = fixture();
    expect((await f.invoke("open", { port: 3000 }))?.[0]).toBe(true);
    f.revokeActor();
    expect((await f.invoke("list"))?.[0]).toBe(false);
    expect(f.service.list()).toHaveLength(1);
    expect(f.close).not.toHaveBeenCalled();
    const target = f.open.mock.calls[0]?.[0].target;
    if (target?.kind !== "worker") {
      throw new Error("missing scoped target");
    }
    const stream = await target.connect();
    stream.destroy();
    expect(f.touch).toHaveBeenCalledTimes(2);
    f.replaceAttachment();
    await expect(target.connect()).rejects.toThrow("attachment replaced");
    expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.touch).toHaveBeenCalledTimes(2);
    f.session.abort(new Error("session reset"));
    expect(f.service.list()).toEqual([]);
    await f.service.closeAll();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
});
