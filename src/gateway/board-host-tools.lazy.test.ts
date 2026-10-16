import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => vi.fn());
const sessionsList = vi.hoisted(() => vi.fn());
const usageStatus = vi.hoisted(() => vi.fn());
const cronRun = vi.hoisted(() => vi.fn());

// mock-isolation: Count family loads without initializing the agent mutation runtime.
vi.mock("./server-methods/agents.js", () => {
  loaded("agents");
  return { agentsHandlers: {} };
});
// mock-isolation: Test cron dispatch without the scheduler's process-wide state.
vi.mock("./server-methods/cron.js", () => {
  loaded("cron");
  return { cronHandlers: { "cron.run": cronRun } };
});
// mock-isolation: Count family loads without initializing health runtime dependencies.
vi.mock("./server-methods/health.js", () => {
  loaded("health");
  return { healthHandlers: {} };
});
// mock-isolation: Keep session stores outside this handler-loading fixture.
vi.mock("./server-methods/sessions-read.js", () => {
  loaded("sessions");
  return { sessionReadHandlers: { "sessions.list": sessionsList } };
});
// mock-isolation: Keep usage and auth stores outside this handler-loading fixture.
vi.mock("./server-methods/usage.js", () => {
  loaded("usage");
  return { usageHandlers: { "usage.status": usageStatus } };
});

import {
  readBoardDataBinding,
  triggerBoardCronJob,
  type BoardCapabilityAuthority,
} from "./board-host-tools.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

describe("board data handler loading", () => {
  it("loads only requested data/action handlers and preserves one-shot usage reads", async () => {
    expect(loaded).not.toHaveBeenCalled();
    const authority = {
      useCurrent: async <T>(run: () => T) => await run(),
    } as BoardCapabilityAuthority;
    const publish = vi.fn();
    const client = { connId: "board-reader" };
    const invocation: GatewayRequestHandlerOptions = {
      req: { type: "req", id: "board-data", method: "board.data.read" },
      params: {},
      respond: publish,
      isWebchatConnect: () => false,
      context: {} as GatewayRequestHandlerOptions["context"],
      client: client as GatewayRequestHandlerOptions["client"],
    };
    sessionsList.mockImplementation(({ respond }) => respond(true, { sessions: [] }));
    usageStatus.mockImplementation(({ respond }) => respond(true, { providers: [] }));
    cronRun.mockImplementation(({ respond }) => respond(true, { ok: true }));

    await readBoardDataBinding("sessions.list", { limit: 5 }, invocation, authority, publish);
    expect(loaded.mock.calls).toEqual([["sessions"]]);
    expect(sessionsList).toHaveBeenCalledWith(
      expect.objectContaining({ client, params: { limit: 5 } }),
    );
    expect(publish).toHaveBeenLastCalledWith(true, { sessions: [] });

    await readBoardDataBinding("usage.status", {}, invocation, authority, publish);
    expect(usageStatus).toHaveBeenCalledWith(expect.objectContaining({ client: null }));
    expect(publish).toHaveBeenLastCalledWith(true, { providers: [] });

    await triggerBoardCronJob("synthetic-job", invocation, authority, publish);
    expect(cronRun).toHaveBeenCalledWith(
      expect.objectContaining({ params: { id: "synthetic-job", mode: "force" } }),
    );
    expect(publish).toHaveBeenLastCalledWith(true, { ok: true });
    expect(loaded.mock.calls).toEqual([["sessions"], ["usage"], ["cron"]]);
  });
});
