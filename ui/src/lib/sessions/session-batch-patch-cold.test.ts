// @vitest-environment node
import { expect, it } from "vitest";
import { sessionRpcHarness } from "./session-rpc.test-support.ts";

it("retires mutations before their first optional runtime finishes loading", async () => {
  const h = sessionRpcHarness({
    "sessions.subscribe": () => ({ subscribed: true }),
    "sessions.patchMany": () => ({ outcomes: [] }),
    "sessions.patch": () => ({ ok: true, key: "agent:main:archive", entry: {} }),
    "sessions.create": () => ({ key: "agent:main:new" }),
  });
  const pending = h.sessions.patchMany(
    [{ key: "agent:main:archive", agentId: "main", expectedSessionId: "archive-incarnation" }],
    { archived: true },
  );
  const patch = h.sessions.patch("agent:main:archive", { label: "Rename" });
  const creation = h.sessions.createResult({ agentId: "main" });
  h.publish(false);
  await expect(pending).resolves.toBeNull();
  await expect(patch).resolves.toBeNull();
  await expect(creation).resolves.toBeNull();
  expect(
    h.request.mock.calls.some(
      ([method]) =>
        method === "sessions.patchMany" ||
        method === "sessions.patch" ||
        method === "sessions.create",
    ),
  ).toBe(false);
});
