import { beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  hoisted,
  provider,
  resetSessionCatalogTestState,
  startCall,
} from "./session-catalog.test-helpers.js";

beforeEach(resetSessionCatalogTestState);

it("records an upstream link and settles the adopted event before responding", async ({
  signal,
}) => {
  const continueSession = vi.fn(async () => ({
    sessionKey: "agent:main:adopted",
    upstream: {
      kind: "codex-app-server" as const,
      ref: { fingerprint: "connection-1", threadId: "thread-1" },
      marker: { turnId: "turn-1" },
    },
  }));
  hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { continueSession }) }];
  const recording = createDeferred();
  const release = createDeferred();
  hoisted.recordSessionStateEventAsync.mockImplementationOnce(async () => {
    recording.resolve();
    await release.promise;
    return undefined;
  });
  const pending = startCall("sessions.catalog.continue", {
    catalogId: "codex",
    hostId: "gateway:local",
    threadId: "thread-1",
  });

  try {
    await withinTest(
      awaitGateBeforeSettlement(
        recording.promise,
        pending.completion,
        "Catalog continuation settled before recording adoption",
      ),
      signal,
    );
    expect(pending.respond).not.toHaveBeenCalled();
    expect(hoisted.upsertSessionUpstreamLink).toHaveBeenCalledWith({
      sessionKey: "agent:main:adopted",
      agentId: "main",
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-1",
      upstreamKind: "codex-app-server",
      upstreamRef: { fingerprint: "connection-1", threadId: "thread-1" },
      marker: { turnId: "turn-1" },
    });
    expect(hoisted.recordSessionStateEventAsync).toHaveBeenCalledWith(
      {
        sessionKey: "agent:main:adopted",
        agentId: "main",
        kind: "adopted",
        actorType: "human",
        summary: "adopted from codex",
        payload: { catalogId: "codex", hostId: "gateway:local" },
        dedupeKey: "adopted:agent:main:adopted",
      },
      { assertCurrent: undefined },
    );
    release.resolve();
    await pending.completion;
    expect(pending.respond).toHaveBeenCalledWith(true, { sessionKey: "agent:main:adopted" });
  } finally {
    release.resolve();
    await pending.completion;
  }
});
