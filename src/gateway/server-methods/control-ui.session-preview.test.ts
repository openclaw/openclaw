import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import * as subagentState from "../../agents/subagents/registry/subagent-registry-state.js";
import { saveSubagentRegistryToSqlite } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { ControlUiSessionPreview } from "../control-ui-contract.js";
import { createControlUiRequestOptions } from "./control-ui-request.test-support.js";
import { controlUiHandlers, createControlUiHandlers } from "./control-ui.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";

const requestOptions = createControlUiRequestOptions(() => ({
  agents: { entries: { main: {} } },
}));

describe("controlUi.sessionPreview", () => {
  it("joins a second compact recovery before presenting an authorized preview", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const sessionKey = "agent:main:dashboard:preview-refill";
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          {
            sessionId: "preview-refill",
            updatedAt: 1,
            label: "Visible during registry recovery",
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: "owner" },
          },
        );
        const run = createSubagentRunRecord({
          runId: "preview-old",
          childSessionKey: "agent:main:subagent:preview-recovery",
          completion: { required: false },
          delivery: { status: "not_required" },
        });
        saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
        subagentState.clearSubagentRunsReadCacheForTest();
        const recoveryStarted = createDeferred();
        const releaseRecovery = createDeferred();
        const execute = stateReads.executeExistingOpenClawStateRead;
        let compactReads = 0;
        const reads = vi
          .spyOn(stateReads, "executeExistingOpenClawStateRead")
          .mockImplementation(async (...args) => {
            const result = await execute(...args);
            if (args[1].type === "subagents.sessionList" && ++compactReads === 2) {
              recoveryStarted.resolve();
              await releaseRecovery.promise;
            }
            return result;
          });
        const prepareCompact = subagentState.prepareSubagentSessionListReadCache;
        let recovering: Promise<unknown> | undefined;
        const prepare = vi
          .spyOn(subagentState, "prepareSubagentSessionListReadCache")
          .mockImplementation(async () => {
            await prepareCompact();
            if (recovering) {
              return;
            }
            const replacement = { ...run, runId: "preview-new", generation: 2 };
            saveSubagentRegistryToSqlite(new Map([[replacement.runId, replacement]]));
            recovering = subagentState.withSubagentRunReadSnapshot(
              new Map(),
              (snapshot) => ({
                runIds: [...snapshot.values()]
                  .filter((entry) => entry.childSessionKey === run.childSessionKey)
                  .map((entry) => entry.runId),
                sessionKeys: [],
              }),
              (selection) => selection.runIds,
            );
            void recovering.catch(() => {});
            await recoveryStarted.promise;
          });
        const respond = vi.fn<RespondFn>();
        const pending = expectDefined(
          createControlUiHandlers()["controlUi.sessionPreview"],
          "session preview handler",
        )(
          requestOptions({ sessionKey }, respond, {
            client: { ...identifiedClient("reader"), connId: "preview-reader" },
            context: { getRuntimeConfig: () => ({}) },
          }),
        );
        try {
          await recoveryStarted.promise;
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          releaseRecovery.resolve();
          await pending;
          await expect(recovering).resolves.toEqual(["preview-new"]);
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ status: "ok", title: "Visible during registry recovery" }),
            undefined,
          );
          expect(compactReads).toBe(2);
        } finally {
          releaseRecovery.resolve();
          await Promise.allSettled([pending, recovering]);
          prepare.mockRestore();
          reads.mockRestore();
          subagentState.clearSubagentRunsReadCacheForTest();
        }
      },
    );
  });

  it("replies in the same authorization frame before queued visibility revocation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:dashboard:preview-response-frame";
      const scope = { agentId: "main", sessionKey };
      const entry = {
        sessionId: "preview-response-frame",
        updatedAt: 1,
        label: "Visible preview title",
        visibility: "shared" as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
      };
      await replaceSessionEntry(scope, entry);
      const events: string[] = [];
      const revoked = createDeferred();
      let queued = false;
      const respond = vi.fn<RespondFn>(() => {
        events.push("response");
      });
      await expectDefined(
        controlUiHandlers["controlUi.sessionPreview"],
        "registered preview",
      )(
        requestOptions({ sessionKey }, respond, {
          client: { ...identifiedClient("reader"), connId: "preview-reader" },
          context: {
            getRuntimeConfig: () => {
              if (!queued) {
                queued = true;
                queueMicrotask(() => {
                  try {
                    replaceSessionEntrySync(scope, { ...entry, visibility: "draft" });
                    events.push("revoked");
                    revoked.resolve();
                  } catch (error) {
                    revoked.reject(error);
                  }
                });
              }
              return {};
            },
          },
        }),
      );
      expect(queued).toBe(true);
      await revoked.promise;
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "ok", title: entry.label }),
        undefined,
      );
      expect(events).toEqual(["response", "revoked"]);
    });
  });

  it("rechecks exact-key visibility after compact registry preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:dashboard:preparing-preview";
      const scope = { agentId: "main", sessionKey };
      const entry = {
        sessionId: "preparing-preview",
        updatedAt: 1,
        label: "Private after preparation",
        visibility: "shared" as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
      };
      await replaceSessionEntry(scope, entry);
      const prepared = createDeferred();
      const identity = vi
        .spyOn(subagentState, "getSubagentSessionListReadSnapshotIdentity")
        .mockReturnValue(undefined);
      const prepare = vi
        .spyOn(subagentState, "prepareSubagentSessionListReadCache")
        .mockReturnValueOnce(prepared.promise);
      const respond = vi.fn<RespondFn>();
      const pending = expectDefined(
        createControlUiHandlers()["controlUi.sessionPreview"],
        "session preview handler",
      )(
        requestOptions({ sessionKey }, respond, {
          client: { ...identifiedClient("reader"), connId: "preview-reader" },
          context: { getRuntimeConfig: () => ({}) },
        }),
      );
      try {
        expect(respond).not.toHaveBeenCalled();
        await replaceSessionEntry(scope, { ...entry, visibility: "draft" });
        identity.mockReturnValue({});
        prepared.resolve();
        await pending;
        expect(respond).toHaveBeenCalledWith(true, { status: "unavailable" }, undefined);
      } finally {
        prepared.resolve();
        await pending;
        prepare.mockRestore();
        identity.mockRestore();
      }
    });
  });

  it("keeps the resolved owner when previewing a qualified global main alias", async () => {
    await withOpenClawTestState({ label: "hover-global-owner" }, async () => {
      const cfg: OpenClawConfig = {
        session: { scope: "global" },
        agents: { entries: { main: { default: true }, research: {} } },
      };
      for (const agentId of ["main", "research"]) {
        const scope = { agentId, sessionKey: "global", sessionId: `hover-${agentId}` };
        await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 42 });
        await persistSessionTranscriptTurn(scope, {
          cwd: "/tmp",
          updateMode: "none",
          messages: [{ message: { role: "user", content: `Title from ${agentId}` }, now: 42 }],
        });
      }
      const handler = expectDefined(
        createControlUiHandlers()["controlUi.sessionPreview"],
        "session preview handler",
      );
      for (const agentId of ["main", "research"]) {
        const respond = vi.fn<RespondFn>();
        await handler(
          requestOptions({ sessionKey: `agent:${agentId}:main` }, respond, {
            context: { getRuntimeConfig: () => cfg },
          }),
        );
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            status: "ok",
            sessionKey: "global",
            agentId,
            derivedTitle: `Title from ${agentId}`,
            lastMessagePreview: `Title from ${agentId}`,
          }),
          undefined,
        );
      }
    });
  });

  it("returns bounded, redacted metadata for one session", async () => {
    const secret = "sk-test-session-preview-secret-1234567890";
    const loadSessionPreview = vi.fn().mockReturnValue({
      sessionKey: "agent:main:research",
      title: `  ${"T".repeat(240)}  `,
      derivedTitle: "  Research notes  ",
      agentId: "main",
      kind: "direct",
      channel: "webchat",
      updatedAt: 1_786_000_000_000,
      lastMessagePreview: `  OPENAI_API_KEY=${secret} ${"x".repeat(240)}  `,
      archived: false,
    });
    const handlers = createControlUiHandlers(vi.fn(), loadSessionPreview);
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPreview"],
      'handlers["controlUi.sessionPreview"] test invariant',
    )(requestOptions({ sessionKey: " agent:main:research " }, respond));

    expect(loadSessionPreview).toHaveBeenCalledWith(
      "agent:main:research",
      expect.any(Object),
      null,
    );
    const payload = respond.mock.calls[0]?.[1] as ControlUiSessionPreview | undefined;
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(payload).toMatchObject({
      status: "ok",
      sessionKey: "agent:main:research",
      derivedTitle: "Research notes",
      agentId: "main",
      kind: "direct",
      channel: "webchat",
      updatedAt: 1_786_000_000_000,
      archived: false,
    });
    if (payload?.status !== "ok") {
      throw new Error("expected an available session preview");
    }
    expect(payload.title).toHaveLength(200);
    expect(payload.lastMessagePreview?.length).toBeLessThanOrEqual(200);
    expect(payload.lastMessagePreview).not.toContain(secret);
  });

  it("returns unavailable for an unknown session", async () => {
    const handlers = createControlUiHandlers(vi.fn(), vi.fn().mockReturnValue(null));
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPreview"],
      'handlers["controlUi.sessionPreview"] test invariant',
    )(requestOptions({ sessionKey: "agent:main:missing" }, respond));

    expect(respond).toHaveBeenCalledWith(true, { status: "unavailable" }, undefined);
  });

  it("rejects malformed preview params", async () => {
    const loadSessionPreview = vi.fn();
    const handlers = createControlUiHandlers(vi.fn(), loadSessionPreview);
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPreview"],
      'handlers["controlUi.sessionPreview"] test invariant',
    )(requestOptions({ sessionKey: "agent:main:research", extra: true }, respond));

    expect(loadSessionPreview).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid controlUi.sessionPreview params",
    });
  });
});
