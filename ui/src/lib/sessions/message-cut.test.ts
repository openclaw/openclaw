import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "./session-capability.test-support.ts";

const key = "agent:main:main";
const editor = {
  editorText: "edit me",
  editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
};
function harness(routes: Record<string, () => unknown>) {
  const request = vi.fn(async (method: string) => {
    const handler = routes[method];
    if (!handler) {
      throw new Error(`Unexpected request: ${method}`);
    }
    return handler();
  });
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  return { ...gateway, request, sessions: createTestSessionCapability(gateway.gateway) };
}

it("returns a committed rewind result after the connection is replaced", async () => {
  const committed = createDeferred<typeof editor>();
  const { sessions, publish, request } = harness({ "sessions.rewind": () => committed.promise });

  const pending = sessions.rewind(key, "user-entry");
  publish(false);
  committed.resolve(structuredClone(editor));

  await expect(pending).resolves.toEqual(editor);
  expect(request).toHaveBeenCalledWith("sessions.rewind", {
    sessionKey: key,
    entryId: "user-entry",
  });
});

it("returns a committed fork result when the replacement refresh fails", async () => {
  const fork = { sessionKey: "agent:main:dashboard:forked", ...editor };
  const { sessions, request } = harness({
    "sessions.fork": () => structuredClone(fork),
    "sessions.list": () => {
      throw new Error("refresh failed");
    },
  });

  await expect(sessions.forkAtMessage(key, "user-entry")).resolves.toEqual(fork);
  expect(request).toHaveBeenCalledWith("sessions.fork", {
    sessionKey: key,
    entryId: "user-entry",
  });
});

it("lists branches and sends the selected leaf to the switch RPC", async () => {
  const branch = {
    leafEntryId: "branch-b",
    headline: "Try the earlier path",
    messageCount: 3,
    active: false,
  };
  const { sessions, request } = harness({
    "sessions.branches.list": () => ({ branches: [branch] }),
    "sessions.branches.switch": () => ({}),
    "sessions.list": () => ({ sessions: [], count: 0 }),
  });

  await expect(sessions.listBranches(key)).resolves.toEqual([branch]);
  await expect(sessions.switchBranch(key, "branch-b")).resolves.toEqual({});
  expect(request).toHaveBeenCalledWith("sessions.branches.switch", {
    sessionKey: key,
    leafEntryId: "branch-b",
  });
});
