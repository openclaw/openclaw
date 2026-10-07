/** A Stop that meets state-database contention must keep the typed uncertainty notice. */
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useChatAbortRegistryFixture } from "./chat.abort-registry.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import * as sessionUtils from "../session-utils.js";
import { sessionAbortHandlers } from "./sessions-abort.js";

useChatAbortRegistryFixture();
afterEach(() => vi.restoreAllMocks());

it("reports typed state contention from sessions.abort", async () => {
  const client = roleClient("view", "sessions-abort-contention");
  client.connect.scopes = ["operator.sessions.write"];
  const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
  setRuntimeConfigSnapshot(cfg);
  vi.spyOn(sessionUtils, "loadSessionEntry").mockImplementation(() => {
    throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  });
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "sessions-abort-contention",
      method: "sessions.abort",
      params: { key: "agent:main:main", runId: "run-1" },
    },
    client,
    context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
    respond,
    isWebchatConnect: () => false,
    extraHandlers: { "sessions.abort": sessionAbortHandlers["sessions.abort"]! },
  });
  console.info(`CONTENTION_PROBE ${JSON.stringify(respond.mock.calls)}`);
  expect(respond).toHaveBeenCalledOnce();
  expect(respond.mock.calls[0]?.[2]).toMatchObject({
    code: "UNAVAILABLE",
    details: { errorKind: "state_contention" },
  });
});
