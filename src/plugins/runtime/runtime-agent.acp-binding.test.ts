import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import * as acpSessionMeta from "../../acp/runtime/session-meta.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

type Create = Parameters<ReturnType<typeof createRuntimeAgent>["session"]["createSessionEntry"]>[0];
type CreateOptions<T = Create> = T extends Create
  ? Omit<T, "cfg" | "key" | "initialEntry"> & Partial<Pick<T, "key" | "initialEntry">>
  : never;
function acpFixture() {
  const key = "agent:main:plugin:acpx:catalog-adopt:pi:source";
  const session = createRuntimeAgent().session;
  const cwd = "/workspace/pi";
  const initialEntry = {
    acpBackendId: "acpx",
    pluginOwnerId: "acpx",
    acpSessionBinding: { acpAgentId: "pi", agentSessionId: "pi-source" },
  };
  return {
    key,
    cwd,
    read: () => session.getSessionEntry({ sessionKey: key, readConsistency: "latest" }),
    create: (params: CreateOptions = {}) =>
      session.createSessionEntry({ cfg: {}, key, initialEntry, ...params }),
    seed: (sessionId: string, pluginExtensions?: SessionEntry["pluginExtensions"]) =>
      session.upsertSessionEntry({
        storePath: session.resolveStorePath(undefined, { agentId: "main" }),
        sessionKey: key,
        entry: {
          sessionId,
          updatedAt: Date.now(),
          delivery: { kind: "none" },
          initializationPending: true,
          pluginOwnerId: "acpx",
          spawnedCwd: cwd,
          pluginExtensions,
          acpSessionBinding: { acpBackendId: "acpx", ...initialEntry.acpSessionBinding },
        },
      }),
    initialEntry,
  };
}
function withAcpFixture(run: (fixture: ReturnType<typeof acpFixture>) => Promise<void>) {
  return withOpenClawTestState({ label: "plugin-runtime-acp" }, () => run(acpFixture()));
}
const readMeta = (sessionKey: string) =>
  acpSessionMeta.readAcpSessionEntry({ cfg: {}, sessionKey })?.acp;
const piBinding = {
  backend: "acpx",
  agent: "pi",
  identity: { agentSessionId: "pi-source", state: "resolved" as const, source: "ensure" as const },
  mode: "persistent" as const,
  cwd: "/workspace/pi",
  state: "idle" as const,
};

it("does not initialize or remove a successor observed after ACP preparation", async () => {
  await withAcpFixture(async ({ key, read, create }) => {
    let successor: Awaited<ReturnType<typeof replaceSessionEntry>> = null;
    const upsert = acpSessionMeta.upsertAcpSessionMeta;
    using prepare = vi
      .spyOn(acpSessionMeta, "upsertAcpSessionMeta")
      .mockImplementationOnce(async (params) => {
        const prepared = await upsert(params);
        const current = read();
        assert(current, "expected the freshly created ACP child");
        successor = await replaceSessionEntry(
          { agentId: "main", sessionKey: key },
          { ...current, sessionId: "successor", lifecycleRevision: "successor-generation" },
        );
        assert(successor, "expected the successor to replace the prepared ACP child");
        return prepared;
      });
    const afterCreate = vi.fn(async () => {
      throw new Error("initializer must not receive a successor");
    });
    await expect(create({ afterCreate })).rejects.toThrow();
    expect(prepare).toHaveBeenCalledOnce();
    expect(afterCreate).not.toHaveBeenCalled();
    expect(read()).toEqual(successor);
  });
});

it("persists a plugin-owned native resume binding", async () => {
  await withAcpFixture(async ({ cwd, create }) => {
    const created = await create({
      key: "plugin:acpx:catalog-adopt:pi:source",
      label: "Pi source",
      spawnedCwd: cwd,
    });
    expect(created.entry).toMatchObject({
      createdVia: "plugin",
      createdActor: { type: "system", id: "acpx" },
      pluginOwnerId: "acpx",
      label: "Pi source",
      spawnedCwd: "/workspace/pi",
    });
    expect(created.entry.initializationPending).toBeUndefined();
    expect(readMeta(created.key)).toMatchObject({
      ...piBinding,
      runtimeSessionName: created.key,
    });
  });
});

it("rejects recovery when the native resume binding differs", async () => {
  await withAcpFixture(async ({ key, cwd, seed, read, create }) => {
    await seed("interrupted-acp-initializer");
    await acpSessionMeta.upsertAcpSessionMeta({
      cfg: {},
      sessionKey: key,
      mutate: () => ({
        ...piBinding,
        runtimeSessionName: key,
        identity: {
          ...piBinding.identity,
          agentSessionId: "different-source",
          lastUpdatedAt: Date.now(),
        },
        cwd,
        lastActivityAt: Date.now(),
      }),
    });
    const stored = read();
    const afterCreate = vi.fn(async () => ({ pluginExtensions: {} }));
    await expect(
      create({ spawnedCwd: cwd, recoverMatchingInitialEntry: true, afterCreate }),
    ).rejects.toThrow("does not match its trusted recovery state");
    expect(afterCreate).not.toHaveBeenCalled();
    expect(read()).toEqual(stored);
  });
});

it("recovers an interrupted ACP initializer before metadata was seeded", async () => {
  await withAcpFixture(async ({ key, cwd, seed, create, initialEntry }) => {
    const marker = { acpx: { piSessionCatalog: { sourceThreadId: "pi-source" } } };
    await seed("interrupted-before-acp-meta", marker);
    const recovered = await create({
      spawnedCwd: cwd,
      recoverMatchingInitialEntry: true,
      initialEntry: { ...initialEntry, pluginExtensions: marker },
      afterCreate: async () => ({ pluginExtensions: marker }),
    });
    const { initializationPending, acpSessionBinding } = recovered.entry;
    expect([initializationPending, acpSessionBinding]).toEqual([undefined, undefined]);
    expect(readMeta(key)).toMatchObject(piBinding);
  });
});
