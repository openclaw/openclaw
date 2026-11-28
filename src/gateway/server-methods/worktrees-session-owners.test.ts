import { expect, test, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { setupGatewaySessionsHandlerTestHarness } from "../test/server-sessions.test-helpers.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
} from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";
import { worktreesHandlers } from "./worktrees.js";

setupGatewaySessionsHandlerTestHarness();

test("looks up exact retained owner sessions without returning an unreadable draft", async () => {
  const cfg = { agents: { entries: { main: {} } } };
  setRuntimeConfigSnapshot(cfg);
  const visible = "agent:main:dashboard:archived-owner";
  const hidden = "agent:main:dashboard:private-draft";
  const now = Date.now();
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: visible },
    {
      sessionId: "retained-session",
      updatedAt: now,
      archivedAt: now,
      displayName: "Prepare the release",
      boardFace: "dashboard",
      visibility: "shared",
      createdActor: { type: "human", source: "profile", id: "another-user" },
    },
  );
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: hidden },
    {
      sessionId: "unreadable-session",
      updatedAt: now,
      displayName: "Private title",
      visibility: "draft",
      createdActor: { type: "human", source: "profile", id: "another-user" },
    },
  );
  const context = requestContext(cfg);
  await initializeSessionReadContext(context);
  const respond = vi.fn<RespondFn>();
  await worktreesHandlers["worktrees.sessionOwners"]!({
    req: { type: "req", id: "worktree-owner-test", method: "worktrees.sessionOwners" },
    params: { keys: [visible, hidden, visible, "agent:main:missing"] },
    client: identifiedClient("worktree-viewer"),
    context,
    respond,
    isWebchatConnect: () => false,
  });
  expect(respond.mock.calls).toEqual([
    [
      true,
      {
        sessions: [
          {
            requestedKey: visible,
            key: visible,
            agentId: "main",
            label: undefined,
            displayName: "Prepare the release",
            boardFace: "dashboard",
          },
        ],
      },
    ],
  ]);
});
