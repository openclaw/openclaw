import path from "node:path";
import { expect, it } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createSessionActorWithExecutor } from "./session-actor-executor.js";
import {
  getSessionActorStorageBinding,
  runWithSessionActorStorage,
} from "./session-actor-storage-binding.js";

function fixture() {
  const env = { OPENCLAW_STATE_DIR: "/synthetic/actor-storage-binding/scope" };
  const options = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const sessionKey = "agent:main:dashboard:incognito-scope";
  const unused = () => {
    throw new Error("Binding validation must not access storage");
  };
  const actor = createSessionActorWithExecutor({
    target: {
      database: { kind: "memory", handle: "scope", incarnation: "scope" },
      sessionKey,
    },
    lifetime: { assertCurrent() {}, assertReadable() {} },
    createExecutor: () => ({
      storage: {
        readCurrent: unused,
        acquire: async () => unused(),
        read: async () => unused(),
        mutate: async () => unused(),
      },
      snapshot: unused,
      read: async () => unused(),
      command: async () => unused(),
      async release() {},
    }),
  });
  const authority = { assertCurrent() {}, authorize() {} };
  return { env, sessionKey, binding: { ...options, actor, authority } };
}

it("refuses another incognito session or owner while accepting its logical store locator", () => {
  const { env, sessionKey, binding } = fixture();
  runWithSessionActorStorage(binding, () => {
    expect(getSessionActorStorageBinding({ sessionKey })?.actor).toBe(binding.actor);
    expect(() =>
      getSessionActorStorageBinding({ sessionKey: "agent:main:dashboard:incognito-other" }),
    ).toThrow("another session");
    expect(getSessionActorStorageBinding({ sessionKey: "agent:main:durable" })).toBeUndefined();
    expect(() =>
      getSessionActorStorageBinding({ sessionKey: "agent:main:durable", sessionActor: binding }),
    ).toThrow("another session");
    expect(
      getSessionActorStorageBinding({
        sessionKey,
        storePath: path.join(env.OPENCLAW_STATE_DIR, "agents/main/sessions/sessions.json"),
      })?.actor,
    ).toBe(binding.actor);
    const foreign = resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: "/synthetic/actor-storage-binding/foreign" },
    });
    expect(() => getSessionActorStorageBinding({ sessionKey, storePath: foreign })).toThrow(
      "another owner",
    );
  });
});
