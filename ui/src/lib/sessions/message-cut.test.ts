import { describe, expect, it, vi } from "vitest";
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
function harness(request: (method: string) => unknown) {
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  return { ...gateway, sessions: createTestSessionCapability(gateway.gateway) };
}

describe("session capability message cuts", () => {
  it("returns a committed rewind result after the connection is replaced", async () => {
    const committed = createDeferred<typeof editor>();
    const request = vi.fn((method: string) => {
      if (method === "sessions.rewind") {
        return committed.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { sessions, publish } = harness(request);

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
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.fork") {
        return structuredClone(fork);
      }
      if (method === "sessions.list") {
        throw new Error("refresh failed");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { sessions } = harness(request);

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
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.branches.list") {
        return { branches: [branch] };
      }
      if (method === "sessions.branches.switch") {
        return {};
      }
      if (method === "sessions.list") {
        return { sessions: [], count: 0 };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { sessions } = harness(request);

    await expect(sessions.listBranches(key)).resolves.toEqual([branch]);
    await expect(sessions.switchBranch(key, "branch-b")).resolves.toEqual({});
    expect(request).toHaveBeenCalledWith("sessions.branches.switch", {
      sessionKey: key,
      leafEntryId: "branch-b",
    });
  });
});
