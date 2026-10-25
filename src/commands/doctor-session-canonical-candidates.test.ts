import path from "node:path";
import { expect, it, vi } from "vitest";
import type { CanonicalSessionRepairFact } from "../config/sessions/session-accessor.js";
import type { ExistingAgentDatabaseTarget } from "../infra/session-sqlite-migration-readers.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { collectCanonicalSessionRepairGroups } from "./doctor-session-canonical-candidates.js";

const inventory = vi.hoisted(() => ({
  listFacts:
    vi.fn<
      typeof import("../config/sessions/session-accessor.js").listCanonicalSessionRepairFacts
    >(),
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.js")>()),
  listCanonicalSessionRepairFacts: inventory.listFacts,
}));

it("preserves per-root cycle choices and database-local missing owners in repair groups", async () => {
  await withStateDirEnv("openclaw-doctor-owner-evidence-", async ({ stateDir }) => {
    const key = (name: string) => `agent:main:dashboard:${name}`;
    const stores: ExistingAgentDatabaseTarget[] = ["local", "remote"].map((name) => ({
      agentId: "main",
      storePath: path.join(stateDir, name, "sessions.json"),
      sqlitePath: path.join(stateDir, name, "agent.sqlite"),
    }));
    const facts: CanonicalSessionRepairFact[] = [
      { sessionKey: key("prefix"), canonicalOwnerSessionKey: key("b"), rawCompareRequired: true },
      { sessionKey: key("c"), canonicalOwnerSessionKey: key("b"), rawCompareRequired: true },
      { sessionKey: key("b"), canonicalOwnerSessionKey: key("c"), rawCompareRequired: true },
      {
        sessionKey: key("missing"),
        canonicalOwnerSessionKey: key("remote"),
        parentSessionKey: key("prefix"),
        rawCompareRequired: true,
      },
    ];
    inventory.listFacts.mockImplementation(({ storePath }) =>
      storePath === stores[0]!.storePath
        ? facts
        : [{ sessionKey: key("remote"), rawCompareRequired: true }],
    );

    const groups = collectCanonicalSessionRepairGroups(
      {
        cfg: {
          agents: { entries: { main: {} } },
          session: { store: path.join(stateDir, "agents", "{agentId}", "sessions.json") },
        },
        env: process.env,
      },
      stores,
    );
    const candidates = new Map(
      groups.flatMap((group) => group.candidates).map((item) => [item.sessionKey, item]),
    );

    expect(
      Object.fromEntries(
        [...candidates].map(([sessionKey, item]) => [sessionKey, item.canonicalKey]),
      ),
    ).toEqual({
      [key("prefix")]: key("b"),
      [key("c")]: key("c"),
      [key("b")]: key("b"),
      [key("missing")]: key("missing"),
      [key("remote")]: key("remote"),
    });
    expect(candidates.get(key("missing"))).toMatchObject({
      canonicalKey: key("missing"),
      normalizedParentSessionKey: key("b"),
    });
  });
});
