import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => vi.fn());
const sessionsList = vi.hoisted(() => vi.fn());
const usageStatus = vi.hoisted(() => vi.fn());
const cronRun = vi.hoisted(() => vi.fn());

vi.mock("./server-methods/agents.js", () => {
  loaded("agents");
  return { agentsHandlers: {} };
});
vi.mock("./server-methods/cron.js", () => {
  loaded("cron");
  return { cronHandlers: { "cron.run": cronRun } };
});
vi.mock("./server-methods/health.js", () => {
  loaded("health");
  return { healthHandlers: {} };
});
vi.mock("./server-methods/sessions-read.js", () => {
  loaded("sessions");
  return { sessionReadHandlers: { "sessions.list": sessionsList } };
});
vi.mock("./server-methods/usage.js", () => {
  loaded("usage");
  return { usageHandlers: { "usage.status": usageStatus } };
});

import {
  readBoardDataBinding,
  triggerBoardCronJob,
  type BoardCapabilityAuthority,
} from "./board-host-tools.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";

describe("board data handler loading", () => {
  it("loads only requested data/action handlers and preserves one-shot usage reads", async () => {
    expect(loaded).not.toHaveBeenCalled();
    const authority = {
      useCurrent: async <T>(run: () => T) => await run(),
    } as BoardCapabilityAuthority;
    const respond = vi.fn();
    const client = { connId: "board-reader" };
    const invocation = {
      req: { type: "req", id: "board-data", method: "board.data.read" },
      context: {},
      client,
    } as GatewayRequestOptions;
    sessionsList.mockImplementation(({ respond }) => respond(true, { sessions: [] }));
    usageStatus.mockImplementation(({ respond }) => respond(true, { providers: [] }));
    cronRun.mockImplementation(({ respond }) => respond(true, { ok: true }));

    await readBoardDataBinding("sessions.list", { limit: 5 }, invocation, authority, respond);
    expect(loaded.mock.calls).toEqual([["sessions"]]);
    expect(sessionsList).toHaveBeenCalledWith(
      expect.objectContaining({ client, params: { limit: 5 } }),
    );
    expect(respond).toHaveBeenLastCalledWith(true, { sessions: [] });

    await readBoardDataBinding("usage.status", {}, invocation, authority, respond);
    expect(usageStatus).toHaveBeenCalledWith(expect.objectContaining({ client: null }));
    expect(respond).toHaveBeenLastCalledWith(true, { providers: [] });

    await triggerBoardCronJob("synthetic-job", invocation, authority, respond);
    expect(cronRun).toHaveBeenCalledWith(
      expect.objectContaining({ params: { id: "synthetic-job", mode: "force" } }),
    );
    expect(respond).toHaveBeenLastCalledWith(true, { ok: true });
    expect(loaded.mock.calls).toEqual([["sessions"], ["usage"], ["cron"]]);
  });
});
