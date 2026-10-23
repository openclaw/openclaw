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
function acpFixture({
  key = "agent:main:plugin:acpx:catalog-adopt:pi:source",
  agent = "pi",
  pluginOwnerId = "acpx",
  sourceId = "pi-source",
} = {}) {
  const session = createRuntimeAgent().session;
  const cwd = `/workspace/${agent}`;
  const initialEntry = {
    acpBackendId: "acpx",
    pluginOwnerId,
    acpSessionBinding: { acpAgentId: agent, agentSessionId: sourceId },
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
          pluginOwnerId,
          spawnedCwd: cwd,
          ...(pluginExtensions ? { pluginExtensions } : {}),
          acpSessionBinding: { acpBackendId: "acpx", ...initialEntry.acpSessionBinding },
        },
      }),
    initialEntry,
  };
}
function withAcpFixture(
  run: (fixture: ReturnType<typeof acpFixture>) => Promise<void>,
  options?: Parameters<typeof acpFixture>[0],
) {
  return withOpenClawTestState({ label: "plugin-runtime-acp" }, () => run(acpFixture(options)));
}
const readMeta = (sessionKey: string) =>
  acpSessionMeta.readAcpSessionEntry({ cfg: {}, sessionKey })?.acp;
const piBinding = { backend: "acpx", agent: "pi", identity: { agentSessionId: "pi-source" } };

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
    expect(successor).toMatchObject({
      sessionId: "successor",
      lifecycleRevision: "successor-generation",
    });
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
      identity: { ...piBinding.identity, state: "resolved", source: "ensure" },
      mode: "persistent",
      cwd: "/workspace/pi",
      state: "idle",
    });
  });
});

it("rejects recovery when the native resume binding differs", async () => {
  await withAcpFixture(
    async ({ key, cwd, seed, read, create }) => {
      await seed("interrupted-acp-initializer");
      await acpSessionMeta.upsertAcpSessionMeta({
        cfg: {},
        sessionKey: key,
        mutate: () => ({
          backend: "acpx",
          agent: "opencode",
          runtimeSessionName: key,
          identity: {
            state: "resolved",
            agentSessionId: "different-source",
            source: "ensure",
            lastUpdatedAt: Date.now(),
          },
          mode: "persistent",
          cwd,
          state: "idle",
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
    },
    {
      key: "agent:main:plugin:opencode:catalog-adopt:source",
      agent: "opencode",
      pluginOwnerId: "opencode",
      sourceId: "expected-source",
    },
  );
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
