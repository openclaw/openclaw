import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";

describe("Gateway creation preparation", () => {
  it.each(["sessionRoot", "spawnedCwd"] as const)(
    "keeps an explicit %s when forking",
    async (destination) => {
      await withOpenClawTestState({ label: "gateway-fork-destination" }, async (state) => {
        const parentRoot = state.path("parent-project");
        const childRoot = state.path("selected-folder");
        await fs.mkdir(parentRoot);
        await fs.mkdir(childRoot);
        const common = {
          cfg: {},
          commandSource: "test",
          operatorRoleActor: { kind: "system" as const },
        };
        const parent = await createGatewaySession({
          ...common,
          key: "agent:main:parent",
          projectId: "parent-project",
          spawnedCwd: parentRoot,
          sessionRoot: parentRoot,
        });
        expect(parent.ok).toBe(true);
        const child = await createGatewaySession({
          ...common,
          key: "agent:main:child",
          parentSessionKey: "agent:main:parent",
          fork: true,
          [destination]: childRoot,
        });
        expect(child).toMatchObject({ ok: true, entry: { [destination]: childRoot } });
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: "agent:main:child" })?.projectId,
        ).toBeUndefined();
      });
    },
  );
  it("infers the child owner from an agent-prefixed parent", async () => {
    await withOpenClawTestState({ label: "gateway-create-parent-owner" }, async (state) => {
      const mainRoot = state.path("ws-main");
      const opsRoot = state.path("ws-ops");
      await fs.mkdir(mainRoot);
      await fs.mkdir(opsRoot);
      const common = {
        cfg: {
          agents: {
            ownership: "explicit" as const,
            entries: { main: { workspace: mainRoot }, ops: { workspace: opsRoot } },
          },
        },
        commandSource: "test",
        operatorRoleActor: { kind: "system" as const },
      };
      const parent = await createGatewaySession({ ...common, key: "agent:ops:main" });
      expect(parent.ok).toBe(true);
      const child = await createGatewaySession({
        ...common,
        parentSessionKey: "agent:ops:main",
        emitCommandHooks: true,
        succeedsParent: false,
      });
      expect(child).toMatchObject({
        ok: true,
        key: expect.stringMatching(/^agent:ops:dashboard:/u),
        entry: { parentSessionKey: "agent:ops:main" },
      });
    });
  });
  it("retains the full adopted target while checking sibling labels", async () => {
    await withOpenClawTestState({ label: "gateway-create-snapshot" }, async () => {
      const create = (key: string, label: string) =>
        createGatewaySession({
          cfg: {},
          key,
          label,
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
        });
      const first = await create("agent:main:target", "Original");
      expect(first.ok).toBe(true);
      const scope = { agentId: "main", sessionKey: "agent:main:target" };
      const initial = loadSessionEntry(scope);
      if (!initial) {
        throw new Error("Missing initial session");
      }
      const saved = {
        ...initial,
        skillsSnapshot: { prompt: "Saved skill prompt", skills: [] },
        systemPromptReport: {
          source: "run" as const,
          generatedAt: 1,
          systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 0, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      };
      replaceSessionEntrySync(scope, saved);
      expect((await create("agent:main:sibling", "Taken")).ok).toBe(true);
      expect(await create(scope.sessionKey, "Renamed")).toMatchObject({
        ok: true,
        entry: { sessionId: saved.sessionId, label: "Renamed" },
      });
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: saved.sessionId,
        label: "Renamed",
        skillsSnapshot: saved.skillsSnapshot,
        systemPromptReport: saved.systemPromptReport,
      });
      expect(await create(scope.sessionKey, "Taken")).toMatchObject({
        ok: false,
        error: { message: "label already in use: Taken" },
      });
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: saved.sessionId,
        label: "Renamed",
        skillsSnapshot: saved.skillsSnapshot,
        systemPromptReport: saved.systemPromptReport,
      });
    });
  });
});
