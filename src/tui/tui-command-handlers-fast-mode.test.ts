import { describe, expect, it, vi } from "vitest";
import { createTuiCommandHandlersHarness } from "./tui-command-handlers-test-support.js";

describe("tui /fast", () => {
  it.each<{
    command: string;
    params?: NonNullable<Parameters<typeof createTuiCommandHandlersHarness>[0]>;
    patch: object;
  }>([
    {
      command: "/fast on",
      params: { currentSessionKey: "global", currentAgentId: "work" },
      patch: { key: "global", agentId: "work", fastMode: true },
    },
    { command: "/fast auto", patch: { key: "agent:main:main", fastMode: "auto" } },
    { command: "/fast ultrafast", patch: { key: "agent:main:main", fastMode: "ultrafast" } },
    {
      command: "/fast default",
      params: { opts: { local: true } },
      patch: { key: "agent:main:main", fastMode: null },
    },
  ])("applies $command through the session setting owner", async ({ command, params, patch }) => {
    const result = { fastMode: "ultrafast" };
    const h = createTuiCommandHandlersHarness({
      ...params,
      patchSession: vi.fn().mockResolvedValue(result),
    });

    await h.handleCommand(command);

    expect(h.patchSession).toHaveBeenCalledWith(patch);
    expect(h.refreshSessionInfo).toHaveBeenCalledOnce();
    expect(h.applySessionInfoFromPatch).toHaveBeenCalledWith(result);
    expect(h.addSystem).toHaveBeenCalledWith(`fast mode set to ${command.slice("/fast ".length)}`);
  });

  it.each(["auto", "ultrafast"] as const)("reports %s session fast mode", async (fastMode) => {
    const h = createTuiCommandHandlersHarness();
    h.state.sessionInfo.fastMode = fastMode;

    await h.handleCommand("/fast status");

    expect(h.addSystem).toHaveBeenCalledWith(`fast mode: ${fastMode}`);
  });

  it("rejects an unknown mode without patching the session", async () => {
    const h = createTuiCommandHandlersHarness();

    await h.handleCommand("/fast hyperspeed");

    expect(h.addSystem).toHaveBeenCalledWith("usage: /fast <status|auto|on|off|ultrafast|default>");
    expect(h.patchSession).not.toHaveBeenCalled();
  });
});
