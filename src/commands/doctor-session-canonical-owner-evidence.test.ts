import { expect, it } from "vitest";
import { applyCanonicalOwnerEvidence } from "./doctor-session-canonical-owner-evidence.js";

it("preserves per-root cycle choices and database-local missing owners", () => {
  const inventory: Parameters<typeof applyCanonicalOwnerEvidence>[0] = [
    { sessionKey: "prefix", canonicalOwnerSessionKey: "b", canonicalKey: "prefix-key" },
    { sessionKey: "c", canonicalOwnerSessionKey: "b", canonicalKey: "c-key" },
    { sessionKey: "b", canonicalOwnerSessionKey: "c", canonicalKey: "b-key" },
    { sessionKey: "missing", canonicalOwnerSessionKey: "remote", canonicalKey: "local-key" },
  ].map((item) =>
    Object.assign(item, {
      storedKey: item.sessionKey,
      target: { agentId: "main", sqlitePath: "/local/agent.sqlite" },
    }),
  );
  inventory.push({
    sessionKey: "remote",
    storedKey: "remote",
    canonicalKey: "remote-key",
    target: { agentId: "main", sqlitePath: "/remote/agent.sqlite" },
  });

  const mappings = applyCanonicalOwnerEvidence(inventory);

  expect(inventory.map((item) => item.canonicalKey)).toEqual([
    "b-key",
    "c-key",
    "b-key",
    "local-key",
    "remote-key",
  ]);
  expect(mappings.get("/local/agent.sqlite\0main\0prefix")).toEqual(new Set(["b-key"]));
  expect(mappings.get("/local/agent.sqlite\0main\0missing")).toEqual(new Set(["local-key"]));
});
