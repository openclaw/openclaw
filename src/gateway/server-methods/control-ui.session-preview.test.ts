import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as subagentState from "../../agents/subagents/registry/subagent-registry-state.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { ControlUiSessionPreview } from "../control-ui-contract.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import * as sessionRows from "../session-row-projection-record.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { createControlUiRequestOptions } from "./control-ui-request.test-support.js";
import { controlUiHandlers, createControlUiHandlers } from "./control-ui.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";

const requestOptions = createControlUiRequestOptions(() => ({
  agents: { entries: { main: {} } },
}));

async function createPreviewContext(cfg: OpenClawConfig = {}, getRuntimeConfig = () => cfg) {
  const projection = await createSessionRowProjection({ cfg });
  onTestFinished(() => projection.dispose());
  await projection.ensureMaterialized();
  return bindSessionRowProjection({ getRuntimeConfig }, () => projection);
}

describe("controlUi.sessionPreview", () => {
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
      const context = await createPreviewContext({}, () => {
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
      });
      await expectDefined(
        controlUiHandlers["controlUi.sessionPreview"],
        "registered preview",
      )(
        requestOptions({ sessionKey }, respond, {
          client: { ...identifiedClient("reader"), connId: "preview-reader" },
          context,
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
      const context = await createPreviewContext();
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
          context,
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

  it("keeps the resolved owner without host SQL when previewing a qualified global main alias", async () => {
    await withOpenClawTestState({ label: "hover-global-owner" }, async () => {
      const cfg: OpenClawConfig = {
        session: { scope: "global" },
        agents: { entries: { main: {}, research: {} } },
      };
      for (const agentId of ["main", "research"]) {
        const scope = { agentId, sessionKey: "global", sessionId: `hover-${agentId}` };
        await replaceSessionEntry(scope, {
          sessionId: scope.sessionId,
          updatedAt: 42,
          displayName: `Title from ${agentId}`,
        });
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
      const publications = new Map([
        ["main", createDeferred()],
        ["research", createDeferred()],
      ]);
      const publishTranscriptFields = sessionRows.publishTranscriptFields;
      const publication = vi
        .spyOn(sessionRows, "publishTranscriptFields")
        .mockImplementation((row, ...args) => {
          const changed = publishTranscriptFields(row, ...args);
          if (row.key === "global" && row.lastMessagePreview === `Title from ${row.agentId}`) {
            publications.get(row.agentId)?.resolve();
          }
          return changed;
        });
      onTestFinished(() => publication.mockRestore());
      const context = await createPreviewContext(cfg);
      await Promise.all([...publications.values()].map((completion) => completion.promise));
      const statements = observeHostDataSql();
      onTestFinished(() => statements.restore());
      for (const agentId of ["main", "research"]) {
        const respond = vi.fn<RespondFn>();
        await handler(
          requestOptions({ sessionKey: `agent:${agentId}:main` }, respond, {
            context,
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
      expect(statements.queries).toEqual([]);
      statements.restore();
    });
  });

  it("returns bounded, redacted metadata for one session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const secret = "sk-test-session-preview-secret-1234567890";
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:research",
        sessionId: "bounded-preview",
      };
      await replaceSessionEntry(scope, {
        sessionId: scope.sessionId,
        displayName: `  ${"T".repeat(240)}  `,
        updatedAt: 1_786_000_000_000,
        delivery: {
          kind: "external",
          route: { channel: "webchat" },
          context: { channel: "webchat" },
          origin: { provider: "webchat" },
        },
      });
      await persistSessionTranscriptTurn(scope, {
        cwd: "/tmp",
        updateMode: "none",
        messages: [
          {
            message: {
              role: "user",
              content: `  OPENAI_API_KEY=${secret} ${"x".repeat(240)}  `,
            },
            now: 1_786_000_000_000,
          },
        ],
      });
      const published = createDeferred();
      const publishTranscriptFields = sessionRows.publishTranscriptFields;
      const publication = vi
        .spyOn(sessionRows, "publishTranscriptFields")
        .mockImplementation((row, ...args) => {
          const changed = publishTranscriptFields(row, ...args);
          if (row.key === scope.sessionKey && row.lastMessagePreview) {
            published.resolve();
          }
          return changed;
        });
      onTestFinished(() => publication.mockRestore());
      const context = await createPreviewContext();
      await published.promise;
      const respond = vi.fn<RespondFn>();
      await expectDefined(
        controlUiHandlers["controlUi.sessionPreview"],
        "session preview handler",
      )(requestOptions({ sessionKey: " agent:main:research " }, respond, { context }));

      const payload = respond.mock.calls[0]?.[1] as ControlUiSessionPreview | undefined;
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(payload).toMatchObject({
        status: "ok",
        sessionKey: scope.sessionKey,
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
      expect(payload.derivedTitle).toHaveLength(200);
      expect(payload.lastMessagePreview).toBeTruthy();
      expect(payload.lastMessagePreview?.length).toBeLessThanOrEqual(200);
      expect(payload.lastMessagePreview).not.toContain(secret);
    });
  });

  it("rejects malformed preview params", async () => {
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      controlUiHandlers["controlUi.sessionPreview"],
      'handlers["controlUi.sessionPreview"] test invariant',
    )(requestOptions({ sessionKey: "agent:main:research", extra: true }, respond));

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid controlUi.sessionPreview params",
    });
  });
});
