import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { writeSkill } from "../skills/test-support/e2e-test-helpers.js";

type ConfigState = { hash: string; path: string; config: Record<string, unknown> };
type RpcResult = { ok: boolean; error?: { message?: string } };

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
  reloadBarrier: { hold: (() => Promise<void>) | undefined };
}) {
  const patch = (baseHash: string, config: unknown) =>
    rpc("config.patch", { baseHash, raw: JSON.stringify(config) });
  const expectOk = async (result: Promise<RpcResult>) => {
    const { ok, error } = await result;
    expect(ok, error?.message).toBe(true);
  };
  it("uses fresh revisions after agent create, update, and delete before reload applies", async () => {
    const workspace = workspacePath("revision-workspace");
    const skill = { name: "revision-guide", description: "Ready after acknowledgement" };
    await writeSkill({
      dir: path.join(workspace, "skills", skill.name),
      ...skill,
    });
    for (const [method, params] of [
      ["agents.create", { name: "revision-worker", workspace }],
      ["agents.update", { agentId: "revision-worker", name: "Ready" }],
      ["agents.delete", { agentId: "revision-worker", deleteFiles: false }],
    ] as const) {
      const before = await getConfigHash();
      const entered = createDeferredCore();
      const gate = createDeferredCore();
      reloadBarrier.hold = () => {
        entered.resolve();
        return gate.promise;
      };
      try {
        // Observe the persisted revision while runtime publication is held.
        const changed = rpc(method, params);
        await awaitGateBeforeSettlement(
          entered.promise,
          changed,
          `${method} settled before publication`,
        );
        const current = await getCurrentConfigObject();
        gate.resolve();
        const result = await changed;
        expect(result.ok, `${method}: ${result.error?.message}`).toBe(true);
        if (method === "agents.create") {
          expect(await rpc("skills.status", { agentId: "revision-worker" })).toMatchObject({
            ok: true,
            payload: { skills: expect.arrayContaining([expect.objectContaining(skill)]) },
          });
        }

        await expectOk(patch(current.hash, { agents: { entries: { main: { name: method } } } }));
        expect(current.hash).not.toBe(before);
      } finally {
        gate.resolve();
        reloadBarrier.hold = undefined;
      }
    }
  });

  it.each([false, true])(
    "agents.delete preserves newer writes across a large shrink (authority revoked: %s)",
    async (revoke) => {
      const configFactory = await import("../config/io.factory.js");
      const { readAgentDeletionJournal, removeAgentDeletionJournal } =
        await import("../test-utils/agent-deletion-journal.js");
      const original = await getCurrentConfigObject();
      await expectOk(patch(original.hash, { logging: { level: "warn" } }));
      for (const name of ["survivor", "doomed"]) {
        await expectOk(rpc("agents.create", { name, workspace: workspacePath(name) }));
        // Config RPC settlement publishes the new roster before the next agent RPC.
        const current = await getCurrentConfigObject();
        await expectOk(patch(current.hash, { agents: { entries: { main: { name } } } }));
      }
      await expectOk(
        rpc("agents.update", { agentId: "doomed", name: "Large agent " + "x".repeat(8192) }),
      );
      const before = await getCurrentConfigObject();
      const beforeRaw = await fs.readFile(original.path, "utf8");
      const newer = { ...JSON.parse(beforeRaw), ui: { prefs: { locale: "fr" } } };
      const createIO = configFactory.createConfigIO;
      let writeCalls = 0;
      using _ = vi.spyOn(configFactory, "createConfigIO").mockImplementation((options) => {
        const io = createIO(options);
        return {
          ...io,
          writeConfigFile: async (...args) => {
            if (io.configPath === original.path && ++writeCalls === 1) {
              // Land an external edit after draft capture, retaining the real writer and guard.
              await fs.writeFile(original.path, `${JSON.stringify(newer, null, 2)}\n`);
              if (revoke) {
                const journal = readAgentDeletionJournal("doomed");
                assert(journal, "Expected the live deletion journal");
                expect(removeAgentDeletionJournal("doomed", journal.operationId)).toBe(true);
              }
            }
            return await io.writeConfigFile(...args);
          },
        };
      });
      const result = await rpc("agents.delete", { agentId: "doomed", deleteFiles: false });
      const raw = await fs.readFile(original.path, "utf8");
      const persisted = JSON.parse(raw);
      if (revoke) {
        expect(result.ok).toBe(false);
        expect(result.error?.message).toContain("deletion no longer owns");
        expect(persisted).toEqual(newer);
        expect(readAgentDeletionJournal("doomed")).toBeUndefined();
      } else {
        expect(result.ok, result.error?.message).toBe(true);
        expect(Buffer.byteLength(raw)).toBeLessThan(Buffer.byteLength(beforeRaw) / 2);
        const expected = structuredClone(newer);
        delete expected.agents.entries.doomed;
        expect(persisted).toEqual({ ...expected, meta: expect.any(Object) });
        const stale = await patch(before.hash, { logging: { level: "debug" } });
        expect(stale.ok).toBe(false);
        expect(stale.error?.message).toContain("config changed since last load");
        expect(await fs.readFile(original.path, "utf8")).toBe(raw);
      }
    },
  );
}
