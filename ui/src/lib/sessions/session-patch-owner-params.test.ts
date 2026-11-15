// @vitest-environment node
import { expect, it } from "vitest";
import { sessionRpcHarness } from "./session-rpc.test-support.ts";

const acpKey = "agent:acp-unlisted:acp:00000000-0000-4000-8000-000000000001";

it("omits a redundant owner when marking a qualified ACP session read", async () => {
  const h = sessionRpcHarness({
    "sessions.patch": () => ({ ok: true, key: acpKey, entry: { sessionId: "acp-session" } }),
    "sessions.subscribe": () => ({ subscribed: true }),
  });

  await h.sessions.patch(
    acpKey,
    { unread: false },
    { agentId: "acp-unlisted", deferListRefresh: true },
  );

  const patch = h.request.mock.calls.find(([method]) => method === "sessions.patch");
  expect(patch?.[1]).toEqual({ key: acpKey, unread: false });
});
it("omits redundant owners from qualified ACP batch patch targets", async () => {
  const h = sessionRpcHarness({
    "sessions.patchMany": () => ({ outcomes: [{ ok: true, key: acpKey }] }),
    "sessions.subscribe": () => ({ subscribed: true }),
  });

  await h.sessions.patchMany(
    [{ key: acpKey, agentId: "acp-unlisted", expectedSessionId: "acp-session" }],
    { archived: true },
  );

  const patch = h.request.mock.calls.find(([method]) => method === "sessions.patchMany");
  expect(patch?.[1]).toEqual({
    targets: [{ key: acpKey, expectedSessionId: "acp-session" }],
    patch: { archived: true },
  });
});
