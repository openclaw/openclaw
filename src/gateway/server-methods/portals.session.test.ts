import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createGatewayPortalService,
  type GatewayPortalService,
} from "../portals/portal-service.js";
import { portalHandlers } from "./portals.js";

const services = new Set<GatewayPortalService>();
afterEach(async () => {
  await Promise.all([...services].map((service) => service.closeAll()));
  services.clear();
});

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
  let actorCurrent = true;
  let attachmentCurrent = true;
  const session = new AbortController();
  const qualification = new AbortController();
  const release = vi.fn();
  const assertActor = () => {
    if (!actorCurrent) {
      throw new Error("actor revoked");
    }
  };
  const assertAttachment = () => {
    if (!attachmentCurrent) {
      throw new Error("attachment replaced");
    }
  };
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => new PassThrough());
  const environments = {
    captureSessionAttachment: vi.fn(() => ({
      binding,
      assertCurrent: assertAttachment,
      touch: async () => {},
    })),
    get: () => ({ ...binding, leaseId: "lease-one", nodeDeviceId: "node-one", sharedHost: false }),
    getDedicatedNodeLeaseSignal: () => (dedicated ? qualification.signal : undefined),
    openNodePortal: vi.fn(async () => ({ connect, close })),
  };
  const service = createGatewayPortalService({ httpBindHosts: ["127.0.0.1"], httpServers: [] });
  const open = vi.spyOn(service, "open");
  services.add(service);
  const access = {
    target: binding,
    sandboxRequired: false,
    assertCurrent: assertActor,
    retainSession: () => ({
      signal: session.signal,
      assertCurrent: () => session.signal.throwIfAborted(),
      release,
    }),
  };
  const broadcast = vi.fn();
  const invoke = async (
    action: "open" | "list" | "close",
    params: Record<string, unknown> = {},
    admitted = true,
  ) => {
    const respond = vi.fn();
    await portalHandlers[`portal.session.${action}`]!({
      params: { sessionKey: binding.sessionKey, environmentId: binding.environmentId, ...params },
      respond,
      context: { workerEnvironmentService: environments, portalService: service, broadcast },
      ...(admitted ? { sessionAccessAuthority: access } : {}),
      sessionMutationCommitGuard: assertActor,
    } as never);
    return respond.mock.calls[0];
  };
  return {
    binding,
    service,
    open,
    environments,
    access,
    session,
    release,
    close,
    connect,
    invoke,
    broadcast,
    revokeActor: () => {
      actorCurrent = false;
    },
    replaceAttachment: () => {
      attachmentCurrent = false;
    },
    unqualify: () => {
      dedicated = false;
      qualification.abort();
    },
  };
}

describe("session-scoped attached worker portals", () => {
  it.each(["session reset", "lost attestation"] as const)(
    "keeps an existing global worker portal separate through %s",
    async (retirement) => {
      const f = fixture();
      const closeGlobal = vi.fn();
      const global = await f.service.open({
        targetPort: 3000,
        target: {
          kind: "worker",
          environmentId: "attached",
          ownerEpoch: 1,
          remotePort: 3000,
          connect: f.connect,
        },
        onClose: closeGlobal,
      });
      expect((await f.invoke("open", { port: 3000 }))?.[0]).toBe(true);
      const scoped = f.service.list().find((portal) => portal.id !== global.id)!;
      expect(scoped).toBeDefined();
      expect(scoped.url).not.toBe(global.url);
      expect((await f.invoke("list"))?.[1]).toEqual({ portals: [scoped] });
      expect((await f.invoke("close", { id: global.id }))?.[0]).toBe(false);
      expect((await f.invoke("open", { port: 3000 }))?.[1]).toEqual(scoped);
      expect(f.service.list()).toHaveLength(2);
      // Reuse releases only the unused new carrier, leaving both original resources owned.
      expect(f.close).toHaveBeenCalledOnce();
      expect(closeGlobal).not.toHaveBeenCalled();
      if (retirement === "session reset") {
        f.session.abort();
      } else {
        f.unqualify();
      }
      expect(f.service.list()).toEqual([global]);
      await f.service.close(scoped.id);
      expect(f.close).toHaveBeenCalledTimes(2);
      expect(f.release).toHaveBeenCalledTimes(2);
      expect(closeGlobal).not.toHaveBeenCalled();
      await f.service.close(global.id);
      expect(closeGlobal).toHaveBeenCalledOnce();
    },
  );

  it("allocates a distinct scoped resource when the attachment generation changes", async () => {
    const f = fixture();
    await f.invoke("open", { port: 3000 });
    const first = f.service.list()[0]!;
    f.binding.generation++;
    await f.invoke("open", { port: 3000 });
    const next = f.service.list().find((portal) => portal.id !== first.id)!;
    expect(next).toBeDefined();
    expect(next.url).not.toBe(first.url);
    expect((await f.invoke("list"))?.[1]).toEqual({ portals: [next] });
    // Environment teardown still finds every scoped prefix and the legacy worker suffix.
    await f.service.closeWorkerPortals("attached", 1);
    expect(f.service.list()).toEqual([]);
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  it("requires admission and explicit dedicated ownership, never falling back to local ports", async () => {
    const f = fixture();
    expect((await f.invoke("open", { port: 3000 }, false))?.[0]).toBe(false);
    expect((await f.invoke("open", { port: 3000, environmentId: "other" }))?.[0]).toBe(false);
    f.unqualify();
    expect((await f.invoke("open", { port: 3000 }))?.[0]).toBe(false);
    expect(f.environments.openNodePortal).not.toHaveBeenCalled();
    expect(f.service.list()).toEqual([]);
  });

  it("returns credentials only for its attachment and redacts broad change events", async () => {
    const f = fixture();
    const unrelated = await f.service.open({ targetPort: 3000 });
    const opened = await f.invoke("open", { port: 3000 });
    expect(opened?.[0]).toBe(true);
    const own = f.service.listWorkerPortals("attached", 1);
    expect(own).toHaveLength(1);
    expect((await f.invoke("list"))?.[1]).toEqual({ portals: own });
    expect((await f.invoke("close", { id: unrelated.id }))?.[0]).toBe(false);
    const payload = f.broadcast.mock.calls[0]?.[1] as { portals: Record<string, unknown>[] };
    expect(payload.portals).toHaveLength(2);
    for (const summary of payload.portals) {
      expect(summary).not.toHaveProperty("url");
      expect(summary).not.toHaveProperty("tokenQuery");
      expect(summary).not.toHaveProperty("resourceOwnerKey");
    }
  });

  it("releases a prepared carrier if actor authority ends during asynchronous startup", async () => {
    const f = fixture();
    const entered = createDeferred();
    const finish = createDeferred();
    f.environments.openNodePortal.mockImplementationOnce(async () => {
      entered.resolve();
      await finish.promise;
      return { close: f.close, connect: f.connect };
    });
    const opening = f.invoke("open", { port: 3000 });
    await entered.promise;
    f.revokeActor();
    finish.resolve();
    expect((await opening)?.[0]).toBe(false);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.service.list()).toEqual([]);
  });

  it("keeps published bearer links after actor revocation but retires them on session reset", async () => {
    const f = fixture();
    expect((await f.invoke("open", { port: 3000 }))?.[0]).toBe(true);
    f.revokeActor();
    expect((await f.invoke("list"))?.[0]).toBe(false);
    expect(f.service.list()).toHaveLength(1);
    expect(f.close).not.toHaveBeenCalled();
    f.session.abort(new Error("session reset"));
    expect(f.service.list()).toEqual([]);
    await f.service.closeAll();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("checks attachment generation again after startup before publishing", async () => {
    const f = fixture();
    f.environments.openNodePortal.mockImplementationOnce(async () => {
      f.replaceAttachment();
      return { close: f.close, connect: f.connect };
    });
    expect((await f.invoke("open", { port: 3000 }))?.[0]).toBe(false);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.service.list()).toEqual([]);
  });

  it("retires an existing scoped resource when dedicated qualification becomes unknown", async () => {
    const f = fixture();
    const global = await f.service.open({ targetPort: 3001 });
    expect((await f.invoke("open", { port: 3000 }))?.[0]).toBe(true);
    f.unqualify();
    expect(f.service.list()).toEqual([global]);
    await f.service.closeWorkerPortals("attached", 1);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("keeps proxy use independent of the initiating actor and rejects replaced attachments", async () => {
    const f = fixture();
    await f.invoke("open", { port: 3000 });
    const target = f.open.mock.calls[0]?.[0].target;
    if (target?.kind !== "worker") {
      throw new Error("missing scoped target");
    }
    f.revokeActor();
    const stream = await target.connect();
    stream.destroy();
    f.replaceAttachment();
    await expect(target.connect()).rejects.toThrow("attachment replaced");
    expect(f.connect).toHaveBeenCalledOnce();
  });
});
