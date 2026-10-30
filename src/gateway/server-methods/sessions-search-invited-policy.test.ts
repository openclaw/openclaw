import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as entryReads from "../../config/sessions/session-entry-read-runtime.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import * as transcriptSearch from "../../config/sessions/session-transcript-search.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  disposeSessionReadContexts,
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

afterEach(() => vi.restoreAllMocks());

it.each(["cap downgrade", "draft transition"] as const)(
  "withholds legacy search hits and page metadata after %s during final preparation",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const owner = ensureProfileForEmail("legacy-search-owner@example.test");
      const member = ensureProfileForEmail("legacy-search-member@example.test");
      const config = (others: "invited" | "none"): OpenClawConfig => ({
        agents: { entries: { main: {} } },
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              // @ts-expect-error Runtime invitation policy precedes config enum activation in step 13.
              reader: { sessions: { others }, agents: "*", scopes: ["operator.read"] },
            },
          },
        },
      });
      let cfg = config("invited");
      setRuntimeConfigSnapshot(cfg);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:legacy-search-invited",
        sessionId: "legacy-search-invited",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      await persistSessionTranscriptTurn(scope, {
        cwd: "/fixture",
        updateMode: "none",
        messages: [{ message: { role: "user", content: "private uniqueneedle" }, now: 1 }],
      });
      addSessionMember(scope, { identityId: member.id, addedBy: owner.id });
      const client = identifiedClient(member.id);
      client.connect.scopes = ["operator.read"];
      const context = requestContext(cfg);
      context.getRuntimeConfig = () => cfg;
      context.getCommittedRuntimeConfig = () => cfg;
      try {
        await initializeSessionReadContext(context);
        const call = async () => {
          const respond = vi.fn<RespondFn>();
          await expectDefined(
            sessionReadHandlers["sessions.search"],
            "search handler",
          )({
            req: { type: "req", id: "legacy-invited", method: "sessions.search" },
            params: { query: "uniqueneedle" },
            context,
            client,
            respond,
            isWebchatConnect: () => false,
          });
          return respond;
        };
        expect(await call()).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            results: [expect.objectContaining({ sessionKey: scope.sessionKey })],
          }),
        );
        let searched = false;
        let downgraded = false;
        const search = transcriptSearch.searchSessionTranscripts;
        vi.spyOn(transcriptSearch, "searchSessionTranscripts").mockImplementation(
          async (...args) => {
            const result = await search(...args);
            searched = true;
            return { ...result, indexing: true, truncated: true, archivedTranscriptsExcluded: 7 };
          },
        );
        const read = entryReads.readSessionEntrySummariesInWorker;
        vi.spyOn(entryReads, "readSessionEntrySummariesInWorker").mockImplementation(
          async (...args) => {
            const result = await read(...args);
            if (searched && !downgraded) {
              if (change === "cap downgrade") {
                cfg = config("none");
                setRuntimeConfigSnapshot(cfg);
              } else {
                await upsertSessionEntryCore(scope, { visibility: "draft" });
              }
              downgraded = true;
            }
            return result;
          },
        );
        const response = await call();
        expect(downgraded).toBe(true);
        expect(client.connect.scopes).toEqual(["operator.read"]);
        expect(response).toHaveBeenCalledExactlyOnceWith(true, { results: [] });
      } finally {
        await disposeSessionReadContexts();
      }
    });
  },
);
