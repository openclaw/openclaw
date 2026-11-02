import { expect, it, vi } from "vitest";
import * as immutableData from "../../shared/immutable-data.js";
import type { SessionActorTarget } from "./session-actor-contract.js";
import { createSessionActorWithExecutor } from "./session-actor-executor.js";

it.each<SessionActorTarget["database"]>([
  { kind: "memory", handle: "synthetic-owner", incarnation: "synthetic-incarnation" },
  {
    kind: "file",
    physicalIdentity: "synthetic-identity",
    birthtime: "1",
    nativeLocation: "/synthetic/agents/main/agent.sqlite",
  },
])(
  "isolates the typed $kind target without inspecting its plain-data shape again",
  async (database) => {
    const input = { database, sessionKey: "agent:main:synthetic" };
    const expected = structuredClone(input);
    const inspect = vi.spyOn(immutableData, "freezeJsonSnapshot");
    const actor = createSessionActorWithExecutor({
      target: input,
      lifetime: { assertCurrent() {}, assertReadable() {} },
      createExecutor({ target }) {
        return {
          snapshot: () => undefined,
          snapshotEntry: () => ({ target, entry: undefined }),
          async read() {
            throw new Error("Unused read");
          },
          async command() {
            throw new Error("Unused command");
          },
          async release() {},
        };
      },
    });
    try {
      input.sessionKey = "changed";
      Object.assign(
        database,
        database.kind === "memory" ? { handle: "changed" } : { nativeLocation: "changed" },
      );
      expect(Reflect.set(actor.target, "sessionKey", "changed")).toBe(false);
      expect(Reflect.set(actor.target.database, "kind", "changed")).toBe(false);
      expect(actor.target).toEqual(expected);
      expect(actor.snapshotEntry({ assertCurrent() {}, authorize() {} })?.target).toEqual(expected);
      expect(inspect).not.toHaveBeenCalled();
    } finally {
      inspect.mockRestore();
      await actor.release();
    }
  },
);
