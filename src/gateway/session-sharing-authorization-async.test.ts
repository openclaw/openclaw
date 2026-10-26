import { afterEach, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import type { SessionMutationAuthorizationParams } from "./session-sharing-authorization.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

const storage = vi.hoisted(() => ({
  prepare: vi.fn(async () => {
    throw new Error("Session storage is unavailable");
  }),
}));

vi.mock("./session-sharing-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing-preparation.js")>()),
  prepareSessionMutationFacts: storage.prepare,
}));

afterEach(() => vi.clearAllMocks());

const sessionKey = "agent:main:plugin-schedule";
const client = sharingPolicyClient({ scopes: ["operator.admin"] });
const context = { getRuntimeConfig: () => ({}) } as GatewayRequestContext;

it("authorizes custom administrator methods while session storage is unavailable", async () => {
  await expect(
    resolveSessionMutationAuthorizationAsync({
      client,
      context,
      method: "scheduler.schedule",
      requestParams: { sessionKey },
    }),
  ).resolves.toEqual({ error: null });
  expect(storage.prepare).not.toHaveBeenCalled();
});

it.each([
  { name: "agent runs", method: "chat.send", requestParams: { sessionKey } },
  { name: "tool execution", method: "tools.invoke", requestParams: { sessionKey } },
  {
    name: "communication changes",
    method: "sessions.patch",
    requestParams: { key: sessionKey, communication: null },
  },
  { name: "progress publication", method: "progressCard.put", requestParams: { sessionKey } },
  {
    name: "captured targets",
    method: "scheduler.schedule",
    requestParams: { sessionKey },
    expectedTarget: {
      agentId: "main",
      sessionKey,
      sessionId: "captured-session",
      storePath: "/unused/store.main.sqlite",
    },
  },
] satisfies Array<
  Pick<SessionMutationAuthorizationParams, "method" | "requestParams" | "expectedTarget"> & {
    name: string;
  }
>)("requires current session facts for $name", async ({ name: _name, ...request }) => {
  await expect(
    resolveSessionMutationAuthorizationAsync({ client, context, ...request }),
  ).rejects.toThrow("Session storage is unavailable");
});
