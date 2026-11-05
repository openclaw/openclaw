import { expect, it } from "vitest";
import { buildSessionCreationStamp } from "./session-entry-provenance.js";
import { applySessionEntryWritePolicy } from "./session-entry-write-policy.js";
import type { InternalSessionEntry } from "./types.js";

const accessModes: [InternalSessionEntry["access"], NonNullable<InternalSessionEntry["access"]>][] =
  [
    [undefined, { mode: "unrestricted" }],
    [{ mode: "creator" }, { mode: "unrestricted" }],
    [{ mode: "source" }, { mode: "creator" }],
    [{ mode: "audience", profileIds: ["selected"] }, { mode: "unrestricted" }],
    [{ mode: "unrestricted" }, { mode: "creator" }],
  ];

it.each(accessModes)(
  "keeps the committed access snapshot stable through bookkeeping: %j",
  (access, staleAccess) => {
    const previous: InternalSessionEntry = {
      sessionId: "owned-generation",
      updatedAt: 1,
      ...buildSessionCreationStamp({
        via: "spawn",
        actor: { type: "agent", id: "main" },
        surface: "plugin-dock",
        inheritedGitContributorProfileIds: ["creator"],
      }),
      ...(access ? { access: structuredClone(access) } : {}),
    };
    const replacement: InternalSessionEntry = {
      ...previous,
      access: staleAccess,
    };
    const { entry } = applySessionEntryWritePolicy(
      "main",
      "agent:main:owned",
      replacement,
      replacement,
      previous,
      {},
    );
    // Initialization and rollback witnesses must match the same row after SQLite JSON encoding.
    expect(entry).toStrictEqual(previous);
    const encodedEntry = JSON.stringify(entry);
    expect(entry).toStrictEqual(JSON.parse(encodedEntry));
  },
);
