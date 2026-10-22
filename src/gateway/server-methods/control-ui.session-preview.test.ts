import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as subagentState from "../../agents/subagents/registry/subagent-registry-state.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { ControlUiSessionPreview } from "../control-ui-contract.js";
import {
  bindSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import * as sessionRows from "../session-row-projection-record.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { createControlUiRequestOptions } from "./control-ui-request.test-support.js";
import { controlUiHandlers } from "./control-ui.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import type { RespondFn } from "./types.js";

const requestOptions = createControlUiRequestOptions(() => ({
  agents: { entries: { main: {} } },
}));
const preview = expectDefined(
  controlUiHandlers["controlUi.sessionPreview"],
  "session preview handler",
);
const sharedEntry = (sessionId: string, label: string) => ({
  sessionId,
  label,
  updatedAt: 1,
  visibility: "shared" as const,
  createdActor: { type: "human" as const, source: "profile" as const, id: "owner" },
});

function expectPreview(respond: RespondFn, payload: unknown) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined);
}

async function createPreviewContext(cfg: OpenClawConfig = {}, getRuntimeConfig = () => cfg) {
  const projection = await createSessionRowProjection({ cfg });
  onTestFinished(() => projection.dispose());
  await projection.ensureMaterialized();
  return bindSessionRowProjection({ getRuntimeConfig }, () => projection);
}

describe("controlUi.sessionPreview", () => {
  it.for(["active", "archived"])(
    "returns a renamed %s preview without waiting for native runtime ownership",
    async (state, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const cfg = { agents: { entries: { main: {} } } };
        setRuntimeConfigSnapshot(cfg);
        const scope = { agentId: "main", sessionKey: "agent:main:preview-owner" };
        const entry = {
          sessionId: "preview-owner",
          updatedAt: 1,
          label: "Original preview",
          visibility: "shared" as const,
          agentHarnessId: "preview-owner",
          modelSelectionLocked: true,
          ...(state === "archived" ? { archivedAt: 1 } : {}),
        };
        replaceSessionEntrySync(scope, entry);
        const previousRegistry = captureActivePluginRegistrySnapshot();
        const registry = createEmptyPluginRegistry();
        const entered = createDeferred();
        const release = createDeferred();
        let holdOwnership = false;
        registry.agentHarnesses.push({
          pluginId: "preview-owner",
          source: "test",
          harness: {
            id: "preview-owner",
            label: "Preview ownership fixture",
            supports: () => ({ supported: true }),
            async resolveSessionRuntimeOwnershipAsync({ assertCurrent }) {
              if (holdOwnership) {
                entered.resolve();
                await release.promise;
              }
              assertCurrent();
              return undefined;
            },
            async runAttempt() {
              throw new Error("Previewing a session must not run a model");
            },
          },
        });
        setActivePluginRegistry(registry);
        const abort = () => release.resolve();
        signal.addEventListener("abort", abort, { once: true });
        let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
        let pending: Promise<void> | undefined;
        try {
          projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
          await projection.ensureMaterialized();
          const context = bindSessionRowProjection(
            { getRuntimeConfig: () => cfg },
            () => projection,
          );
          const respond = vi.fn<RespondFn>();
          const first = await projection.withSelectionPreparation(async () => {
            holdOwnership = true;
            replaceSessionEntrySync(scope, { ...entry, label: "Renamed preview", updatedAt: 2 });
            pending = Promise.resolve(
              preview(requestOptions({ sessionKey: scope.sessionKey }, respond, { context })),
            );
            const winner = await Promise.race([
              pending.then(() => "response" as const),
              entered.promise.then(() => "native ownership" as const),
            ]);
            release.resolve();
            await pending;
            expectPreview(
              respond,
              expect.objectContaining({
                status: "ok",
                title: "Renamed preview",
                updatedAt: 2,
                archived: state === "archived",
              }),
            );
            return winner;
          });
          expect(first).toBe("response");
        } finally {
          release.resolve();
          await Promise.allSettled(pending ? [pending] : []);
          projection?.dispose();
          restoreActivePluginRegistrySnapshot(previousRegistry);
          signal.removeEventListener("abort", abort);
        }
      });
    },
  );

  it("replies in the same authorization frame before queued visibility revocation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:dashboard:preview-response-frame";
      const scope = { agentId: "main", sessionKey };
      const entry = sharedEntry("preview-response-frame", "Visible preview title");
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
      await preview(
        requestOptions({ sessionKey }, respond, {
          client: { ...identifiedClient("reader"), connId: "preview-reader" },
          context,
        }),
      );
      expect(queued).toBe(true);
      await revoked.promise;
      expectPreview(respond, expect.objectContaining({ status: "ok", title: entry.label }));
      expect(events).toEqual(["response", "revoked"]);
    });
  });

  it("rechecks exact-key visibility after compact registry preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const sessionKey = "agent:main:dashboard:preparing-preview";
      const scope = { agentId: "main", sessionKey };
      const entry = sharedEntry("preparing-preview", "Private after preparation");
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
      const pending = preview(
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
        expectPreview(respond, { status: "unavailable" });
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
      setRuntimeConfigSnapshot(cfg);
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
      for (const agentId of publications.keys()) {
        requireSessionRowProjection(context).describe({ key: "global", agentId });
      }
      await Promise.all([...publications.values()].map((completion) => completion.promise));
      const statements = observeHostDataSql();
      onTestFinished(() => statements.restore());
      for (const agentId of ["main", "research"]) {
        const respond = vi.fn<RespondFn>();
        await preview(
          requestOptions({ sessionKey: `agent:${agentId}:main` }, respond, {
            context,
          }),
        );
        expectPreview(
          respond,
          expect.objectContaining({
            status: "ok",
            sessionKey: "global",
            agentId,
            derivedTitle: `Title from ${agentId}`,
            lastMessagePreview: `Title from ${agentId}`,
          }),
        );
      }
      expect(statements.queries).toEqual([]);
      statements.restore();
    });
  });

  it("returns bounded, original metadata for one session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
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
      const content = `  OPENAI_API_KEY=${secret} ${"x".repeat(240)}  `;
      await persistSessionTranscriptTurn(scope, {
        cwd: "/tmp",
        updateMode: "none",
        messages: [{ message: { role: "user", content }, now: 1_786_000_000_000 }],
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
      requireSessionRowProjection(context).describe({
        key: scope.sessionKey,
        agentId: scope.agentId,
      });
      await published.promise;
      const respond = vi.fn<RespondFn>();
      await preview(requestOptions({ sessionKey: " agent:main:research " }, respond, { context }));

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
      expect(payload.lastMessagePreview).toContain(secret);
    });
  });

  it("rejects malformed preview params", async () => {
    const respond = vi.fn<RespondFn>();

    await preview(requestOptions({ sessionKey: "agent:main:research", extra: true }, respond));

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid controlUi.sessionPreview params",
    });
  });
});
