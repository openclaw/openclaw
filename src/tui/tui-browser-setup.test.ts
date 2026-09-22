import { describe, expect, it, vi } from "vitest";
import {
  createTuiCommandHandlersHarness,
  flushAsyncSelect,
} from "./tui-command-handlers-test-support.js";
import { createEditorSubmitHandler } from "./tui-submit.js";

describe("/browser-setup local process dispatch", () => {
  function setupResponse(action = "inspect", profile = "chrome") {
    return {
      action,
      target: { kind: "local-host", profile, hostname: "private-host", relayPort: 18792 },
      phase: "needs_browser_action",
      reason: "secret-in-unexpected-reason",
      installation: {
        nativeHostRegistered: true,
        installRequested: true,
        discoveredProfiles: 0,
        awaitingApproval: true,
        automaticBootstrapSupported: true,
      },
      connection: { state: "not_checked", extensionVersion: "secret-in-version" },
      nextAction: "approve_extension",
      pairingKey: "secret-in-extra-field",
    };
  }

  it.each([
    { local: false, profile: "chrome" },
    { local: true, profile: "chrome" },
    { local: false, profile: "work" },
    { local: true, profile: "work" },
  ])(
    "uses selector-free host-local argv with local=$local and profile=$profile, even when disconnected",
    async ({ local, profile }) => {
      const runJson = vi.fn().mockImplementation(async (args: string[]) => ({
        ok: true,
        value: setupResponse(args[4], profile),
      }));
      const localCli = { runJson, cancel: vi.fn(() => false), shutdown: vi.fn(async () => {}) };
      const h = createTuiCommandHandlersHarness({ opts: { local }, isConnected: false, localCli });
      expect(runJson).not.toHaveBeenCalled();
      for (const action of ["", "install", "verify"]) {
        await h.handleCommand("/browser-setup " + action);
        expect(runJson).toHaveBeenLastCalledWith([
          "browser",
          "extension",
          "setup",
          "--action",
          action || "inspect",
          "--json",
          "--wait-ms",
          "1000",
        ]);
      }
      expect(h.sendChat).not.toHaveBeenCalled();
      expect(h.openOverlay).not.toHaveBeenCalled();
      expect(h.addSystem).toHaveBeenCalledWith(
        expect.stringContaining(`target=TUI process host (not the Gateway), profile=${profile}`),
      );
      expect(h.addSystem).toHaveBeenCalledWith(
        expect.stringContaining("Approve the extension in Chrome"),
      );
      expect(JSON.stringify(h.addSystem.mock.calls)).not.toMatch(/secret-in|private-host/);
    },
  );

  it("rejects extra arguments without history, model forwarding, or local execution", async () => {
    const runJson = vi.fn();
    const localCli = { runJson, cancel: vi.fn(() => false), shutdown: vi.fn(async () => {}) };
    const h = createTuiCommandHandlersHarness({ localCli });
    const editor = { getExpandedText: () => "", setText: vi.fn(), addToHistory: vi.fn() };
    const submit = createEditorSubmitHandler({
      editor,
      handleCommand: h.handleCommand,
      sendMessage: h.sendMessage,
      handleBangLine: vi.fn(),
      onSubmitError: vi.fn(),
    });
    for (const input of [
      "/browser-setup install --token secret-input",
      "/browser-setup verify; whoami",
      "/BROWSER-SETUP install\nsecret-input",
      "/browser-setup pair secret-input",
    ]) {
      submit(input);
    }
    await flushAsyncSelect();
    expect(runJson).not.toHaveBeenCalled();
    expect(editor.addToHistory).not.toHaveBeenCalled();
    expect(h.sendChat).not.toHaveBeenCalled();
    expect(h.addSystem).toHaveBeenCalledWith(expect.stringContaining("Usage: /browser-setup"));
    expect(JSON.stringify(h.addSystem.mock.calls)).not.toContain("secret-input");
  });

  it.each(["/stop", "/abort"])(
    "%s cancels local setup as well as the active chat",
    async (command) => {
      const cancel = vi.fn(() => true);
      const h = createTuiCommandHandlersHarness({
        localCli: { runJson: vi.fn(), cancel, shutdown: vi.fn(async () => {}) },
      });
      await h.handleCommand(command);
      expect(cancel).toHaveBeenCalledOnce();
      expect(h.abortActive).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { ok: false, reason: "execution_failed" },
    { ok: true, value: { ...setupResponse(), phase: "secret-in-phase" } },
    { ok: true, value: { ...setupResponse(), target: { kind: "remote", profile: "chrome" } } },
    { ok: true, value: setupResponse("inspect", "") },
    { ok: true, value: setupResponse("inspect", "work/private") },
    { ok: true, value: setupResponse("inspect", "x".repeat(65)) },
    { ok: true, value: setupResponse("inspect", "work\nsecret-in-profile") },
  ])("reports bounded failures without exposing response content", async (result) => {
    const h = createTuiCommandHandlersHarness({
      localCli: {
        runJson: vi.fn().mockResolvedValue(result),
        cancel: vi.fn(() => false),
        shutdown: vi.fn(async () => {}),
      },
    });
    await h.handleCommand("/browser-setup");
    expect(h.addSystem).toHaveBeenCalledWith(
      expect.stringMatching(/execution_failed|invalid_response/),
    );
    expect(JSON.stringify(h.addSystem.mock.calls)).not.toContain("secret-in");
    expect(h.sendChat).not.toHaveBeenCalled();
  });
});
