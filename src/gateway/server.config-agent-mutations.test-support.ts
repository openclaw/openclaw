import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";

type ConfigState = { hash: string; path: string; config: Record<string, unknown> };
type RpcResult = { ok: boolean; error?: { message?: string } };

/** Agent cases share the config suite's real authenticated Gateway and teardown. */
export function registerAgentConfigMutationTests({
  getCurrentConfigObject,
  getConfigHash,
  rpc,
  workspacePath,
  reloadBarrier,
}: {
  getCurrentConfigObject: () => Promise<ConfigState>;
  getConfigHash: () => Promise<string>;
  rpc: (method: string, params: unknown) => Promise<RpcResult>;
  workspacePath: (name: string) => string;
  reloadBarrier: { wait: Promise<void> | undefined };
}) {
  it("uses fresh revisions after agent create, update, and delete before reload applies", async () => {
    const operations = [
      {
        method: "agents.create",
        params: { name: "revision-worker", workspace: workspacePath("revision-workspace") },
      },
      { method: "agents.update", params: { agentId: "revision-worker", name: "Ready" } },
      { method: "agents.delete", params: { agentId: "revision-worker", deleteFiles: false } },
    ];
    for (const operation of operations) {
      const before = await getConfigHash();
      const gate = createDeferredCore();
      reloadBarrier.wait = gate.promise;
      try {
        const changed = await rpc(operation.method, operation.params);
        expect(changed.ok, `${operation.method}: ${changed.error?.message}`).toBe(true);

        const current = await getCurrentConfigObject();
        gate.resolve();
        const patched = await rpc("config.patch", {
          baseHash: current.hash,
          raw: JSON.stringify({ agents: { entries: { main: { name: operation.method } } } }),
        });
        expect(patched.ok, patched.error?.message).toBe(true);
        expect(current.hash).not.toBe(before);
      } finally {
        gate.resolve();
        reloadBarrier.wait = undefined;
      }
    }
  });

  it.each([false, true])(
    "agents.delete preserves newer writes across a large shrink (authority revoked: %s)",
    async (revoke) => {
      const configFactory = await import("../config/io.factory.js");
      const { readAgentDeletionJournal, removeAgentDeletionJournal } =
        await import("../state/agent-deletion-journal.js");
      const original = await getCurrentConfigObject();
      const seed = await rpc("config.patch", {
        raw: JSON.stringify({ logging: { level: "warn" } }),
        baseHash: original.hash,
      });
      expect(seed.ok, seed.error?.message).toBe(true);
      for (const name of ["survivor", "doomed"]) {
        const created = await rpc("agents.create", { name, workspace: workspacePath(name) });
        expect(created.ok, created.error?.message).toBe(true);
        // Config RPC settlement publishes the new roster before the next agent RPC.
        const current = await getCurrentConfigObject();
        const applied = await rpc("config.patch", {
          baseHash: current.hash,
          raw: JSON.stringify({ agents: { entries: { main: { name } } } }),
        });
        expect(applied.ok, applied.error?.message).toBe(true);
      }
      const enlarged = await rpc("agents.update", {
        agentId: "doomed",
        name: "Large agent " + "x".repeat(8192),
      });
      expect(enlarged.ok, enlarged.error?.message).toBe(true);
      const before = await getCurrentConfigObject();
      const beforeRaw = await fs.readFile(original.path, "utf8");
      const newer = { ...JSON.parse(beforeRaw), ui: { prefs: { locale: "fr" } } };
      const createIO = configFactory.createConfigIO;
      let writeCalls = 0;
      const observation = vi
        .spyOn(configFactory, "createConfigIO")
        .mockImplementation((options) => {
          const io = createIO(options);
          return {
            ...io,
            writeConfigFile: async (...args) => {
              if (io.configPath === original.path && ++writeCalls === 1) {
                // A real external edit lands after deletion captured its draft.
                // Keep the actual writer, conflict detection, retry and journal guard.
                await fs.writeFile(original.path, `${JSON.stringify(newer, null, 2)}\n`);
                if (revoke) {
                  const journal = readAgentDeletionJournal("doomed");
                  if (!journal) {
                    throw new Error("Expected the live deletion journal");
                  }
                  expect(removeAgentDeletionJournal("doomed", journal.operationId)).toBe(true);
                }
              }
              return await io.writeConfigFile(...args);
            },
          };
        });
      const gate = createDeferredCore();
      reloadBarrier.wait = gate.promise;
      try {
        const result = await rpc("agents.delete", {
          agentId: "doomed",
          deleteFiles: false,
        });
        const raw = await fs.readFile(original.path, "utf8");
        const persisted = JSON.parse(raw);
        if (revoke) {
          expect(result.ok).toBe(false);
          expect(result.error?.message).toContain("deletion no longer owns");
          expect(writeCalls).toBe(1);
          expect(persisted).toEqual(newer);
          expect(readAgentDeletionJournal("doomed")).toBeUndefined();
        } else {
          expect(result.ok, result.error?.message).toBe(true);
          expect(writeCalls).toBe(2);
          expect(Buffer.byteLength(raw)).toBeLessThan(Buffer.byteLength(beforeRaw) / 2);
          expect(persisted).toEqual({
            ...newer,
            meta: expect.any(Object),
            agents: {
              ...newer.agents,
              entries: {
                main: newer.agents.entries.main,
                survivor: newer.agents.entries.survivor,
              },
            },
          });
          const stale = await rpc("config.patch", {
            baseHash: before.hash,
            raw: JSON.stringify({ logging: { level: "debug" } }),
          });
          expect(stale.ok).toBe(false);
          expect(stale.error?.message).toContain("config changed since last load");
          expect(await fs.readFile(original.path, "utf8")).toBe(raw);
        }
      } finally {
        gate.resolve();
        reloadBarrier.wait = undefined;
        observation.mockRestore();
      }
    },
  );
}
