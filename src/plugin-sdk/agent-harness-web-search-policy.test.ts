import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAdmittedHostCapabilityTestFixture } from "../agents/harness/host-capability.test-support.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.entry.js";
import * as sessionReads from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createDirectChatContext } from "../gateway/server-chat.agent-events.test-helpers.js";
import { SessionRowProjectionBinding } from "../gateway/session-row-projection-binding.js";
import { createSessionRowCapabilityReader } from "../gateway/session-row-projection-identities.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

it.each(["active", "aborted during preparation", "closed during preparation"])(
  "prepares harness search policy after deletion only while the attempt is %s",
  async (lifetime) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:dashboard:harness-search";
      const entry: SessionEntry = {
        sessionId: "harness-search",
        updatedAt: 1,
        spawnedBy: "agent:main:main",
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: ["web_search"],
      };
      await upsertSessionEntryCore(
        {
          agentId: "main",
          sessionKey,
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        },
        entry,
      );
      let topologyDirty = false;
      const readProjection = createSessionRowCapabilityReader({
        state: () => ({ disposed: false, topologyDirty }),
        lookup: () => undefined,
        matching: () => [],
      });
      const context = createDirectChatContext({
        sessionRowProjectionOwner: new SessionRowProjectionBinding({}, (query) =>
          topologyDirty ? readProjection(query) : { entry },
        ),
      });
      const abort = new AbortController();
      const host = await createAdmittedHostCapabilityTestFixture(
        {
          runId: "harness-search",
          agentId: "main",
          sessionKey,
          sessionId: entry.sessionId,
          config: {},
          abortSignal: abort.signal,
        },
        { hostCapabilityVersion: 2 },
      );
      const preparePolicy = host.hostCapabilities.prepareWebSearchToolPolicy!;
      beginAgentDeletionJournal({
        agentId: "retiring",
        operationId: "harness-search-delete",
        agentDir: state.agentDir("retiring"),
        sessionsDir: state.sessionsDir("retiring"),
        workspaceDir: state.statePath("workspace-retiring"),
        deleteFiles: false,
        phase: "draining",
      });
      topologyDirty = true;
      const entered = createDeferred();
      const resume = createDeferred();
      const readFromWorker = sessionReads.withSessionEntriesFromStoreInWorker;
      using read = vi
        .spyOn(sessionReads, "withSessionEntriesFromStoreInWorker")
        .mockImplementation(async (...args) => {
          entered.resolve();
          if (lifetime !== "active") {
            await resume.promise;
          }
          return await readFromWorker(...args);
        });
      try {
        const preparation = withPluginRuntimeGatewayContextResolver(
          () => context,
          () =>
            preparePolicy({ config: {}, agentId: "main", sessionKey, sessionId: entry.sessionId }),
        );
        if (lifetime !== "active") {
          await entered.promise;
          if (lifetime === "aborted during preparation") {
            abort.abort(new Error("attempt aborted during preparation"));
          } else {
            host.closeHost();
          }
          resume.resolve();
          await expect(preparation).rejects.toThrow(
            lifetime === "aborted during preparation"
              ? "attempt aborted during preparation"
              : "no longer active",
          );
        } else {
          await expect(preparation).resolves.toEqual({ allowed: false, persistentAllowed: false });
        }
        expect(read).toHaveBeenCalled();
      } finally {
        resume.resolve();
        host.closeHost();
        host.closeAdmission();
      }
    });
  },
);

it("rejects a retained policy preparer after the attempt host closes", async () => {
  const host = await createAdmittedHostCapabilityTestFixture(
    { runId: "retained-search" },
    { hostCapabilityVersion: 2 },
  );
  const prepare = host.hostCapabilities.prepareWebSearchToolPolicy!;
  try {
    host.closeHost();
    await expect(prepare({ webSearchEnabled: false })).rejects.toThrow("no longer active");
  } finally {
    host.closeHost();
    host.closeAdmission();
  }
});
