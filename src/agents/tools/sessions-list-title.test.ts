import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, test, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntryReadOnly,
  readSessionTranscriptWatermark,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  disposeSessionReadContexts,
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
} from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { getSessionRowProjection } from "../../gateway/session-row-projection-access.js";
import * as transcriptTitles from "../../gateway/session-transcript-title-reader.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import type { GatewaySessionListRow, SessionListRow } from "./sessions-helpers.js";
import { createSessionsListTool } from "./sessions-list-tool.js";
import { VALID_CONFIG } from "./sessions-list.test-support.js";

type FixtureRow = {
  row: Partial<GatewaySessionListRow> & { subject?: string };
  transcript?: boolean;
};

afterEach(() => memorySessionActorOwners.reset());

async function withInventory(
  definitions: FixtureRow[],
  run: (fixture: {
    render: (includeLastMessage?: boolean) => Promise<{ sessions: SessionListRow[] }>;
    readSessionIds: () => string[];
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = ensureProfileForEmail("inventory-title-owner@example.test");
    const viewer = ensureProfileForEmail("inventory-title-reader@example.test");
    const cfg: OpenClawConfig = {
      ...VALID_CONFIG,
      agents: { entries: { main: {}, other: {} } },
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: {
              agents: ["main", "other"],
              sessions: { others: "view" },
              scopes: ["operator.read"],
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const scopes = definitions.map(({ row }, index) => ({
      agentId: row.agentId ?? "main",
      sessionKey: row.key ?? `agent:main:dashboard:inventory-${index}`,
      sessionId: row.sessionId ?? `inventory-${index}`,
    }));
    for (const [index, { row, transcript }] of definitions.entries()) {
      const scope = scopes[index]!;
      const entry: SessionEntry = {
        sessionId: scope.sessionId,
        updatedAt: row.updatedAt ?? 1_000 - index,
        label: row.label,
        displayName: row.displayName,
        subject: row.subject,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: owner.id },
        ...(isIncognitoSessionKey(scope.sessionKey) ? { incognito: true } : {}),
      };
      if (isIncognitoSessionKey(scope.sessionKey)) {
        await replaceSessionEntry(scope, entry);
      } else {
        replaceSessionEntrySync(scope, entry);
      }
      if (!transcript) {
        continue;
      }
      for (const message of [
        { role: "user", content: `Topic ${index}.` },
        { role: "assistant", content: `Preview ${index}.` },
      ]) {
        expect(appendTranscriptMessageSync(scope, { message }).ok).toBe(true);
      }
    }
    const persisted = () =>
      scopes.map((scope, index) => ({
        entry: loadSessionEntryReadOnly(scope),
        watermark: definitions[index]?.transcript
          ? readSessionTranscriptWatermark(scope)
          : undefined,
      }));
    const before = persisted();
    const context = requestContext(cfg);
    context.trackExecution = async (operation) => await operation();
    await initializeSessionReadContext(context);
    const client = identifiedClient(viewer.id);
    const authority = {
      authenticatedUserProfile: expectDefined(client.authenticatedUserProfile, "reader"),
      scopes: ["operator.read"],
    };
    const overrides = new Map(
      scopes.map((scope, index) => [scope.sessionKey, definitions[index]!.row]),
    );
    const projection = expectDefined(getSessionRowProjection(context), "inventory projection");
    const presentRow = projection.present.bind(projection);
    const presentation = vi.spyOn(projection, "present").mockImplementation((...args) => {
      const row = presentRow(...args);
      // Inject wire edges before publication; keep actor metadata below the byte budget.
      Object.assign(row, overrides.get(row.key));
      delete row.createdActor;
      delete row.owner;
      return row;
    });
    const tool = createSessionsListTool({
      config: cfg,
      agentSessionKey: "agent:main:main",
      callGateway: callAgentToolGatewayRequest,
    });
    const reads = vi.spyOn(transcriptTitles, "readSessionTitleFieldsFromTranscriptAsync");
    try {
      await run({
        readSessionIds: () => reads.mock.calls.map(([scope]) => scope.sessionId),
        render: async (includeLastMessage = false) => {
          reads.mockClear();
          return await withPluginRuntimeGatewayRequestScope(
            { context, isWebchatConnect: () => false },
            () =>
              withOperatorToolGatewayAuthority(
                authority,
                async () =>
                  (
                    await tool.execute("inventory-titles", {
                      includeDerivedTitles: true,
                      includeLastMessage,
                      limit: definitions.length,
                    })
                  ).details as { sessions: SessionListRow[] },
              ),
          );
        },
      });
      expect(persisted()).toEqual(before);
    } finally {
      reads.mockRestore();
      presentation.mockRestore();
      await disposeSessionReadContexts();
    }
  });
}

test("does not hydrate named tool rows while preserving projected titles and visibility", async () => {
  await withInventory(
    [
      ...[
        { label: " Explicit ", displayName: "Stored" },
        { displayName: " Display ", subject: "Subject" },
        { derivedTitle: "Gateway", label: "Ignored" },
        { derivedTitle: " \t ", label: "Ignored" },
        { label: " ", displayName: " ", subject: " Subject " },
        { label: " ", displayName: " ", subject: " " },
      ].map((row) => ({ row, transcript: true })),
      { row: { sessionId: undefined, label: "No identity" } },
      { row: { key: "agent:other:main", agentId: "other", derivedTitle: "Hidden agent" } },
      { row: { key: "agent:main:dashboard:incognito-hidden", derivedTitle: "Hidden incognito" } },
    ],
    async ({ render, readSessionIds }) => {
      const titles = await render();
      expect(titles.sessions.map((row) => row.derivedTitle)).toEqual([
        "Explicit",
        "Display",
        "Gateway",
        " \t ",
        "Subject",
        "Topic 5.",
        undefined,
      ]);
      expect(readSessionIds()).toEqual(["inventory-5"]);
      const previews = await render(true);
      expect(readSessionIds().toSorted()).toEqual(
        Array.from({ length: 6 }, (_, index) => `inventory-${index}`),
      );
      expect(previews.sessions.slice(0, 6).map((row) => row.lastMessagePreview)).toEqual(
        Array.from({ length: 6 }, (_, index) => `Preview ${index}.`),
      );
      for (const row of previews.sessions) {
        delete row.lastMessagePreview;
      }
      expect(previews).toEqual(titles);
    },
  );
});

test("keeps the first 100 tool session identities when named titles skip hydration", async () => {
  await withInventory(
    [
      { row: { sessionId: undefined, label: "No identity" } },
      ...Array.from({ length: 99 }, (_, index) => ({ row: { label: `Named ${index}` } })),
      { row: {}, transcript: true },
      { row: {}, transcript: true },
    ],
    async ({ render, readSessionIds }) => {
      const result = await render();
      expect(result.sessions).toHaveLength(102);
      expect([0, 99, 100, 101].map((index) => result.sessions[index]?.derivedTitle)).toEqual([
        undefined,
        "Named 98",
        "Topic 100.",
        undefined,
      ]);
      expect(readSessionIds()).toEqual(["inventory-100"]);
    },
  );
});
