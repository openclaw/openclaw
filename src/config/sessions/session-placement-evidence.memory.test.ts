import { afterEach, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "./session-actor-storage-binding.js";
import { readPlacementSessionIdentityEvidence } from "./session-placement-evidence.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory placement evidence opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory placement evidence allocated a worker");
  }),
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/memory-placement-evidence" };
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
afterEach(() => {
  memorySessionActorOwners.reset();
  vi.unstubAllEnvs();
});

it("resolves current and ambiguous memory identities without creating missing owners", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  const location = {
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const owner = memorySessionActorOwners.get(location);
  const keyFor = (name: string) => `agent:main:dashboard:incognito-${name}`;
  const [key, alias, unknown, unique] = ["current", "alias", "unknown", "unique"].map(keyFor);
  const actors = await Promise.all(
    [key!, alias!, unique!].map((sessionKey) =>
      owner.acquire({ database: owner.identity, sessionKey }, lifetime),
    ),
  );
  try {
    for (const actor of actors) {
      const entry = {
        sessionId: actor.target.sessionKey === unique ? "unique-id" : "shared-id",
        updatedAt: 1,
        incognito: true as const,
      };
      const result = await actor.storage!.mutate(
        { type: "session.entry.create", input: { entry } },
        authority,
      );
      expect(result.kind).toBe("committed");
    }
    const probe = (sessionId: string, sessionKey = unknown!, agentId = "main") => ({
      agentId,
      sessionKey,
      sessionId,
    });
    const absent = { status: "absent" };
    const cases = [
      [probe("shared-id", key), { status: "current", sessionKey: key }],
      [probe("shared-id"), { status: "unknown", reason: "ambiguous" }],
      [probe("unique-id"), { status: "current", sessionKey: unique }],
      [probe("missing-id"), absent],
      [probe("shared-id", "agent:missing:dashboard:incognito-unknown", "missing"), absent],
    ] as const;
    const probes = cases.map(([input]) => input);
    const expected = cases.map(([, result]) => result);
    const read = (input = probes) => readPlacementSessionIdentityEvidence({}, input);
    expect(await read()).toEqual(expected);
    expect(
      await runWithSessionActorStorage({ ...location, actor: actors[0]!, authority }, () => read()),
    ).toEqual(expected);
    expect(memorySessionActorOwners.list()).toEqual([owner]);
    owner.closeSession(unique!);
    expect(await read([probes[2]!])).toEqual([absent]);
    vi.stubEnv("OPENCLAW_STATE_DIR", "/synthetic/another-placement-root");
    expect(await read([probes[0]!])).toEqual([absent]);
    expect(memorySessionActorOwners.list()).toEqual([owner]);
  } finally {
    await Promise.all(actors.map((actor) => actor.release()));
  }
});
