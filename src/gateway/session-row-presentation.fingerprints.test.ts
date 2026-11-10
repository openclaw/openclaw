import { hash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  persistSessionTranscriptTurn,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import {
  createSessionRowDeltaDiffer,
  prepareSessionRowDeltaFields,
} from "./session-row-delta-fields.js";
import { createSessionRowEventPeer } from "./session-row-event.test-support.js";
import { reuseSessionRowFields } from "./session-row-identity.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import {
  createTestProjection,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";
import { rolePolicyConfig } from "./session-sharing.test-utils.js";
import { replaceSessionRowFacts } from "./session-utils-row.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, hash: vi.fn(crypto.hash) };
});

it("retains nested publication facts across real transcript writes without hiding replacements", async () => {
  using clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const profiles = ["owner", "writer", "viewer"].map((role) => {
      const profile = ensureProfileForEmail(`${role}@fingerprints.test`);
      setUserProfileRole(profile.id, role === "writer" ? "write" : "view");
      return profile;
    });
    const clients = profiles.map(
      (profile) => createSessionRowEventPeer(profile, profile.id, Date.now()).client,
    );
    const cfg = rolePolicyConfig();
    const query = { agentId: "main", key: "agent:main:fingerprint-publication" };
    const target = { agentId: query.agentId, sessionKey: query.key, sessionId: "fingerprints" };
    const toolOverrides = { mcpToolsDeny: { synthetic: ["unchanged-tool".repeat(100)] } };
    seedRow(query, {
      sessionId: target.sessionId,
      updatedAt: Date.now(),
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: profiles[0]!.id },
      toolOverrides,
    });
    const append = () =>
      persistSessionTranscriptTurn(target, {
        touchSessionEntry: true,
        messages: [
          {
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", id: `call-${Date.now()}`, name: "exec", arguments: {} },
              ],
              timestamp: Date.now(),
            },
          },
        ],
      });
    await append();
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    const read = async (unchanged = false) => {
      await projection.ensureMaterialized();
      const publication = prepareSessionRowPublication(projection, Date.now());
      const common = projection.describe(query)!.materialized.row;
      using keys = vi.spyOn(Object, "keys");
      const rows = clients.map((client) => {
        const row = publication(client).getPresentation().snapshot(query).row!;
        return {
          row,
          fields: prepareSessionRowDeltaFields(row, common),
        };
      });
      // Common nested facts are prepared once, never traversed again per audience.
      if (unchanged) {
        expect(keys.mock.calls.filter(([value]) => value === common.toolOverrides)).toHaveLength(0);
      }
      expect(rows.every(({ row }) => row.toolOverrides === common.toolOverrides)).toBe(true);
      return rows;
    };
    let previous = await read();
    expect(previous.map(({ row }) => row.activitySummary?.canEnsure)).toEqual([true, true, false]);
    for (let update = 0; update < 3; update++) {
      clock.mockReturnValue(Date.now() + 1);
      await append();
      vi.mocked(hash).mockClear();
      const current = await read(true);
      const nestedHashes = vi
        .mocked(hash)
        .mock.calls.filter(([, encoded]) => typeof encoded === "string" && /^[{[]/.test(encoded));
      expect(nestedHashes).toHaveLength(0);
      current.forEach(({ row, fields }, index) => {
        expect(
          JSON.stringify(createSessionRowDeltaDiffer()(previous[index]!.fields, fields, row)),
        ).toBe(
          JSON.stringify({ set: { updatedAt: Date.now(), snapshotAt: Date.now() }, remove: [] }),
        );
      });
      previous = current;
    }
    const replacement = { mcpToolsDeny: { synthetic: ["replacement-tool"] } };
    await updateSessionEntry(target, () => ({ toolOverrides: replacement }), {
      skipMaintenance: true,
    });
    const changed = await read();
    changed.forEach(({ row, fields }, index) => {
      expect(
        JSON.stringify(createSessionRowDeltaDiffer()(previous[index]!.fields, fields, row)),
      ).toBe(JSON.stringify({ set: { toolOverrides: replacement }, remove: [] }));
    });
    setUserProfileRole(profiles[2]!.id, "write");
    prepareGatewayRecipientProfile(clients[2]!);
    const admitted = await read();
    expect(
      createSessionRowDeltaDiffer()(changed[2]!.fields, admitted[2]!.fields, admitted[2]!.row).set
        .activitySummary,
    ).toEqual({ state: "unavailable", canEnsure: true });
    // The row fact owner may publish equal JSON values in a different property order.
    const record = projection.describe(query)!;
    for (const mcpToolsDeny of [
      { a: ["a"], b: ["b"] },
      { b: ["b"], a: ["a"] },
    ]) {
      record.materialized = replaceSessionRowFacts(record.materialized, {
        toolOverrides: { mcpToolsDeny },
      });
      expect(JSON.stringify((await read())[0]!.row.toolOverrides)).toBe(
        JSON.stringify({ mcpToolsDeny }),
      );
    }
  });
});

it.each([
  [[], Array<string>(1)],
  [Array<string>(1), []],
])("preserves array JSON when sharing row fields (%j → %j)", (before, after) => {
  const row = (value: string[]): GatewaySessionRow => ({
    key: "agent:main:array-bytes",
    kind: "direct",
    updatedAt: 0,
    pluginExtensions: [{ pluginId: "fixture", namespace: "values", value }],
  });
  const previous = row(before);
  const next = row(after);
  const expected = JSON.stringify(next);
  expect(JSON.stringify(reuseSessionRowFields(next, previous))).toBe(expected);
});
