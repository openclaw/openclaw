import { expect, it } from "vitest";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import {
  disposeSessionReadContexts,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

it("classifies deployed publication tasks across cold reads without hiding ordinary spawns", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const parent = "agent:main:dashboard:publication-parent";
    const suffixes = [
      "github-00000000-0000-8000-8000-000000000001",
      "github-publication-0123456789abcdef0123456789abcdef",
      "human-task",
      "github-publication-how-to",
      "github-publication-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "random-publication-key",
    ];
    const keys = suffixes.map((suffix) => `agent:main:dashboard:${suffix}`);
    const labels = [
      "Renamed publication",
      suffixes[1]!,
      suffixes[1]!,
      "github-publication-how-to",
      "Human task",
      "github-publication-00000000-0000-8000-8000-000000000001",
    ];
    for (const [index, key] of keys.entries()) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId: `publication-${index}`,
          updatedAt: Date.now(),
          visibility: "shared",
          parentSessionKey: parent,
          spawnedBy: parent,
          createdVia: index === 4 ? "operator" : "spawn",
          ...(index === 5 ? { createdSurface: "github-publication" as const } : {}),
          createdActor:
            index === 4 || index === 0
              ? { type: "human", source: "profile", id: "publication-reader" }
              : { type: "agent", id: "main" },
          // A renamed backing task stays internal; a human's label never identifies custody.
          label: labels[index],
          displayName: "GitHub publication",
        },
      );
    }
    const cfg = rolePolicyConfig();
    const client = roleClient("view", "publication-reader");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    prepareGatewayRecipientProfile(client);
    for (let attempt = 0; attempt < 2; attempt++) {
      const context = requestContext(cfg);
      const read = (excludeSystem: boolean) =>
        listSessions({
          context,
          client,
          request: { spawnedBy: parent, excludeSystem, limit: 100 },
        });
      const all = await read(false);
      for (const [index, key] of keys.entries()) {
        const row = all.sessions.find((candidate) => candidate.key === key);
        expect(row?.label).toBe(index === 1 || index === 5 ? undefined : labels[index]);
        expect(row?.displayName).toBe(
          index === 1 || index === 5 ? "GitHub publication" : labels[index],
        );
        expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: key })?.label).toBe(
          labels[index],
        );
      }
      expect(
        all.sessions
          .map((row) => [row.key, row.classification])
          .toSorted(([a], [b]) => a!.localeCompare(b!)),
      ).toEqual(
        [
          [keys[0], "github-publication"],
          [keys[1], "github-publication"],
          [keys[2], "dashboard"],
          [keys[3], "dashboard"],
          [keys[4], "dashboard"],
          [keys[5], "github-publication"],
        ].toSorted(([a], [b]) => a!.localeCompare(b!)),
      );
      const visible = await read(true);
      expect(visible.sessions.map((row) => row.key).toSorted()).toEqual(
        keys.slice(2, 5).toSorted(),
      );
      await disposeSessionReadContexts();
    }
  });
});
