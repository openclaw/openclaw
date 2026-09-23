import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntryReadOnly,
  readSessionTranscriptWatermark,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  disposeSessionReadContexts,
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
} from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import * as transcriptTitles from "../../gateway/session-transcript-title-reader.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import type { GatewaySessionListRow, SessionListRow } from "./sessions-helpers.js";
import { createSessionsListTool } from "./sessions-list-tool.js";
import { VALID_CONFIG } from "./sessions-list.test-support.js";

type FixtureRow = {
  row: Partial<GatewaySessionListRow> & { subject?: string };
  transcript?: boolean;
};

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
      agents: { entries: { main: { default: true }, other: {} } },
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
    const rows = definitions.map(({ row }, index) => ({
      key: `agent:main:dashboard:inventory-${index}`,
      sessionId: `inventory-${index}`,
      agentId: "main",
      kind: "direct" as const,
      classification: "dashboard" as const,
      updatedAt: 1_000 - index,
      ...row,
    }));
    const scopes = rows.map((row, index) => ({
      agentId: row.agentId,
      sessionKey: row.key,
      sessionId: row.sessionId ?? `inventory-${index}`,
    }));
    for (const [index, definition] of definitions.entries()) {
      const row = rows[index]!;
      const scope = scopes[index]!;
      replaceSessionEntrySync(scope, {
        sessionId: scope.sessionId,
        updatedAt: row.updatedAt ?? 0,
        label: row.label,
        displayName: row.displayName,
        subject: row.subject,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: owner.id },
        ...(isIncognitoSessionKey(scope.sessionKey) ? { incognito: true } : {}),
      });
      if (!definition.transcript) {
        continue;
      }
      for (const message of [
        { role: "user", content: `Find inventory topic ${index}.` },
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
    const asReader = <T>(operation: () => Promise<T>) =>
      withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, () =>
        withOperatorToolGatewayAuthority(
          {
            authenticatedUserProfile: expectDefined(client.authenticatedUserProfile, "reader"),
            scopes: ["operator.read"],
          },
          operation,
        ),
      );
    const overrides = new Map(rows.map((row, index) => [row.key, definitions[index]!.row]));
    const callGateway: AgentToolGatewayRequestCaller = async <T>(
      request: Parameters<AgentToolGatewayRequestCaller>[0],
    ): Promise<T> => {
      if (request.method !== "sessions.list") {
        return await callAgentToolGatewayRequest<T>(request);
      }
      expect(request.params).toMatchObject({
        includeDerivedTitles: false,
        includeLastMessage: false,
      });
      const response = await callAgentToolGatewayRequest<{ sessions: GatewaySessionListRow[] }>(
        request,
      );
      for (const row of response.sessions) {
        // Preserve the producer's row binding while exercising optional wire-field edge cases.
        Object.assign(row, overrides.get(row.key));
        // Keep the title-admission fixture below the separately tested byte budget.
        delete row.createdActor;
        delete row.owner;
      }
      // SAFETY: the registered method produced this response; only its row metadata was overlaid.
      return response as T;
    };
    const tool = createSessionsListTool({
      config: cfg,
      agentSessionKey: "agent:main:main",
      callGateway,
    });
    const reads = vi.spyOn(transcriptTitles, "readSessionTitleFieldsFromTranscriptAsync");
    try {
      await run({
        readSessionIds: () => reads.mock.calls.map(([scope]) => scope.sessionId),
        render: async (includeLastMessage = false) => {
          reads.mockClear();
          return await asReader(
            async () =>
              (
                await tool.execute("inventory-titles", {
                  includeDerivedTitles: true,
                  includeLastMessage,
                  limit: definitions.length,
                })
              ).details as { sessions: SessionListRow[] },
          );
        },
      });
      expect(persisted()).toEqual(before);
    } finally {
      reads.mockRestore();
      await disposeSessionReadContexts();
    }
  });
}

test("does not hydrate named tool rows while preserving projected titles and visibility", async () => {
  await withInventory(
    [
      { row: { label: " Explicit ", displayName: "Stored" }, transcript: true },
      { row: { displayName: " Projected display ", subject: "Subject" }, transcript: true },
      { row: { derivedTitle: "Gateway title", label: "Ignored" }, transcript: true },
      { row: { derivedTitle: " \t ", label: "Ignored" }, transcript: true },
      { row: { label: " ", displayName: " ", subject: " Subject title " }, transcript: true },
      { row: { label: " ", displayName: " ", subject: " " }, transcript: true },
      { row: { sessionId: undefined, label: "No identity" } },
      { row: { key: "agent:other:main", agentId: "other", derivedTitle: "Hidden agent" } },
      { row: { key: "agent:main:dashboard:incognito-hidden", derivedTitle: "Hidden incognito" } },
    ],
    async ({ render, readSessionIds }) => {
      const titles = await render();
      expect(titles.sessions.map((row) => row.derivedTitle)).toEqual([
        "Explicit",
        "Projected display",
        "Gateway title",
        " \t ",
        "Subject title",
        "Find inventory topic 5.",
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
      expect(result.sessions[0]?.derivedTitle).toBeUndefined();
      expect(result.sessions[99]?.derivedTitle).toBe("Named 98");
      expect(result.sessions[100]?.derivedTitle).toBe("Find inventory topic 100.");
      expect(result.sessions[101]?.derivedTitle).toBeUndefined();
      expect(readSessionIds()).toEqual(["inventory-100"]);
    },
  );
});
