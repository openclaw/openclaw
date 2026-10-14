import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  parseComputerActParamsJSON,
  parseComputerActResult,
  parseComputerUseCapabilityDescriptor,
  parseScreenSnapshotResult,
} from "./computer-use-contract.js";
import {
  registerComputerUseProvider,
  type ComputerUseProvider,
} from "./computer-use-registration.js";
import type { OpenClawPluginNodeHostCommand } from "./types.js";

function capabilityDescriptor(
  actions: ReturnType<ComputerUseProvider["capabilities"]>["actions"] = ["screenshot"],
): ReturnType<ComputerUseProvider["capabilities"]> {
  return {
    contractVersion: 2,
    provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
    actions,
    targets: ["screen"],
    deliveryModes: ["foreground"],
    observations: ["image"],
    features: { recording: false, agentCursor: false, multiDisplay: false },
  };
}

function registerProvider(
  openExecution: ComputerUseProvider["openExecution"],
  overrides: Partial<ComputerUseProvider> = {},
): OpenClawPluginNodeHostCommand[] {
  const commands: OpenClawPluginNodeHostCommand[] = [];
  registerComputerUseProvider(
    { registerNodeHostCommand: (command) => commands.push(command) },
    {
      id: "fixture",
      label: "Fixture",
      capabilities: capabilityDescriptor,
      isAvailable: () => true,
      openExecution,
      ...overrides,
    },
  );
  return commands;
}

describe("Computer Use wire contract", () => {
  it("projects the canonical screen.snapshot result", () => {
    expect(
      parseScreenSnapshotResult({
        format: "jpeg",
        base64: "aGk=",
        displayFrameId: "frame-1",
        width: 100,
        height: 50,
        capturedAtMs: 42,
        ignored: true,
      }),
    ).toEqual({
      format: "jpeg",
      base64: "aGk=",
      displayFrameId: "frame-1",
      width: 100,
      height: 50,
      capturedAtMs: 42,
    });
  });

  it("accepts the portable recording family without native path or helper inputs", () => {
    const resourceHandle = "openclaw:computer-resource:v1:123e4567-e89b-42d3-a456-426614174000";
    for (const input of [
      { action: "get_recording_state" },
      { action: "start_recording", recordVideo: true },
      { action: "stop_recording" },
      { action: "replay_trajectory", resourceHandle, delayMs: 25, stopOnError: false },
      {
        action: "browser_set_input_files",
        browserRef: "browser-1",
        pageRef: "page-1",
        observationId: "observation-1",
        elementRef: "element-1",
        resourceHandles: [resourceHandle],
      },
      {
        action: "browser_download",
        browserRef: "browser-1",
        pageRef: "page-1",
        observationId: "observation-1",
        elementRef: "element-1",
      },
    ]) {
      expect(parseComputerActParamsJSON(JSON.stringify(input))).toEqual(input);
    }

    for (const input of [
      { action: "start_recording", output_dir: "/tmp/recording" },
      { action: "start_recording", helperPath: "/tmp/ffmpeg" },
      { action: "replay_trajectory", dir: "../outside" },
      { action: "replay_trajectory", ffmpegPath: "/tmp/ffmpeg" },
      { action: "get_window_state", windowRef: "window-1", session: "native-session" },
      { action: "left_click", binaryPath: "/tmp/cua-driver" },
      { action: "left_click", socketPath: "/tmp/cua.sock" },
      { action: "left_click", driverArgs: ["--dangerously-bypass-approvals"] },
      { providerTool: "click", arguments: { x: 1, y: 2 } },
      {
        action: "browser_set_input_files",
        browserRef: "browser-1",
        pageRef: "page-1",
        observationId: "observation-1",
        elementRef: "element-1",
        files: ["/tmp/input.txt"],
      },
      {
        action: "browser_download",
        browserRef: "browser-1",
        pageRef: "page-1",
        observationId: "observation-1",
        elementRef: "element-1",
        destinationRoot: "/tmp/downloads",
      },
    ]) {
      expect(() => parseComputerActParamsJSON(JSON.stringify(input))).toThrow(
        "COMPUTER_INVALID_REQUEST",
      );
    }
  });

  it("caps semantic observations and provider detail records", () => {
    const element = {
      elementRef: "element-1",
      role: "button",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    };
    expect(
      parseComputerActResult({
        ok: true,
        observation: {
          kind: "window",
          observationId: "observation-1",
          elements: Array.from({ length: 2_000 }, () => element),
        },
        details: Object.fromEntries(
          Array.from({ length: 64 }, (_, index) => [`key-${index}`, index]),
        ),
      }),
    ).toMatchObject({ ok: true });
    expect(() =>
      parseComputerActResult({
        ok: true,
        observation: {
          kind: "window",
          elements: Array.from({ length: 2_001 }, () => element),
        },
      }),
    ).toThrow("COMPUTER_CONTRACT_MISMATCH");
    expect(() =>
      parseComputerActResult({
        ok: true,
        details: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`key-${index}`, index]),
        ),
      }),
    ).toThrow("COMPUTER_CONTRACT_MISMATCH");
  });

  it("validates the bounded node capability descriptor", () => {
    expect(
      parseComputerUseCapabilityDescriptor(capabilityDescriptor(["screenshot", "left_click"])),
    ).toMatchObject({ contractVersion: 2 });
    expect(() =>
      parseComputerUseCapabilityDescriptor(capabilityDescriptor(["left_click", "left_click"])),
    ).toThrow("COMPUTER_CONTRACT_MISMATCH");
  });
});

describe("Computer Use provider registration", () => {
  it.each(["same", "different", "same-close", "different-close"] as const)(
    "preserves queued acquisition and close order for %s",
    async (laterOwner) => {
      const firstId = "123e4567-e89b-42d3-a456-426614174000";
      const nextId = "223e4567-e89b-42d3-a456-426614174000";
      const laterId = laterOwner.startsWith("same")
        ? nextId
        : "323e4567-e89b-42d3-a456-426614174000";
      const closeLater = laterOwner.endsWith("-close");
      const firstClose = createDeferredCore();
      const nextClose = createDeferredCore();
      const close = vi
        .fn(async () => {})
        .mockImplementationOnce(() => firstClose.promise)
        .mockImplementationOnce(() => nextClose.promise);
      const openExecution = vi.fn(async () => ({
        snapshot: async () => "snapshot",
        act: async () => "act",
        close,
      }));
      const commands = registerProvider(openExecution);
      const snapshot = commands[0]!;
      const computer = commands[1]!;
      expect(commands.map((command) => command.hasActiveWork?.())).toEqual([false, false]);
      await snapshot.handle(JSON.stringify({ executionId: firstId }));
      expect(commands.map((command) => command.hasActiveWork?.())).toEqual([true, true]);
      const retiringFirst = computer.handle(
        JSON.stringify({ executionId: firstId, action: "__close_execution" }),
      );
      const openingNext = snapshot.handle(JSON.stringify({ executionId: nextId }));
      const retiringNext = computer.handle(
        JSON.stringify({ executionId: nextId, action: "__close_execution" }),
      );
      const laterSnapshot = snapshot.handle(JSON.stringify({ executionId: laterId }));
      const retiringLater = closeLater
        ? computer.handle(JSON.stringify({ executionId: laterId, action: "__close_execution" }))
        : undefined;
      const laterSettled = vi.fn();
      const observedLater = laterSnapshot.then(laterSettled, laterSettled);
      const laterCloseSettled = vi.fn();
      const observedLaterClose = retiringLater?.then(laterCloseSettled, laterCloseSettled);
      const operations = Promise.allSettled([
        retiringFirst,
        openingNext,
        retiringNext,
        laterSnapshot,
        ...(retiringLater ? [retiringLater] : []),
      ]);
      try {
        firstClose.resolve();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(openExecution).toHaveBeenCalledTimes(2);
        expect(close).toHaveBeenCalledTimes(2);
        expect(commands.map((command) => command.hasActiveWork?.())).toEqual([true, true]);
        expect(laterSettled).not.toHaveBeenCalled();
        expect(laterCloseSettled).not.toHaveBeenCalled();
        nextClose.resolve();
        expect(await operations).toEqual([
          { status: "fulfilled", value: '{"ok":true}' },
          { status: "fulfilled", value: "snapshot" },
          { status: "fulfilled", value: '{"ok":true}' },
          { status: "fulfilled", value: "snapshot" },
          ...(closeLater ? [{ status: "fulfilled", value: '{"ok":true}' }] : []),
        ]);
        expect(openExecution).toHaveBeenCalledTimes(3);
        expect(close).toHaveBeenCalledTimes(closeLater ? 3 : 2);
        expect(commands.map((command) => command.hasActiveWork?.())).toEqual([
          !closeLater,
          !closeLater,
        ]);
      } finally {
        firstClose.resolve();
        nextClose.resolve();
        await operations;
        await observedLater;
        await observedLaterClose;
        await snapshot.onDisconnect?.();
        expect(commands.map((command) => command.hasActiveWork?.())).toEqual([false, false]);
      }
    },
  );

  it("retains terminal close failure without confusing it with failed-open recovery", async () => {
    const executionId = "123e4567-e89b-42d3-a456-426614174000";
    const otherId = "223e4567-e89b-42d3-a456-426614174000";
    const openFailure = new Error("native driver startup failed");
    const closeFailure = new Error("native driver shutdown failed");
    const failedOpening =
      createDeferredCore<Awaited<ReturnType<ComputerUseProvider["openExecution"]>>>();
    const physicalClose = vi.fn(async () => {
      throw closeFailure;
    });
    let terminalClose: Promise<void> | undefined;
    const close = vi.fn(() => (terminalClose ??= physicalClose()));
    const openExecution = vi
      .fn<ComputerUseProvider["openExecution"]>(async () => ({
        snapshot: async () => "snapshot",
        act: async () => "act",
        close,
      }))
      .mockImplementationOnce(() => failedOpening.promise);
    const commands = registerProvider(openExecution);
    const snapshot = commands[0]!;
    const computer = commands[1]!;
    const params = JSON.stringify({ executionId });
    const closeParams = JSON.stringify({ executionId, action: "__close_execution" });
    const opening = snapshot.handle(params);
    const closingFailedOpen = computer.handle(closeParams);
    expect(commands.map((command) => command.hasActiveWork?.())).toEqual([true, true]);
    const failedOpenResults = Promise.allSettled([opening, closingFailedOpen]);
    failedOpening.reject(openFailure);
    expect(await failedOpenResults).toEqual([
      { status: "rejected", reason: openFailure },
      { status: "rejected", reason: openFailure },
    ]);
    expect(commands.map((command) => command.hasActiveWork?.())).toEqual([false, false]);
    await expect(snapshot.handle(params)).resolves.toBe("snapshot");
    await expect(computer.handle(closeParams)).rejects.toBe(closeFailure);
    expect(commands.map((command) => command.hasActiveWork?.())).toEqual([true, true]);
    await expect(
      computer.handle(JSON.stringify({ executionId: otherId, action: "__close_execution" })),
    ).resolves.toBe('{"ok":true}');
    expect(close).toHaveBeenCalledOnce();

    await expect(computer.handle(closeParams)).rejects.toBe(closeFailure);
    await expect(snapshot.handle(JSON.stringify({ executionId: otherId }))).rejects.toBe(
      closeFailure,
    );
    expect(openExecution).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(physicalClose).toHaveBeenCalledOnce();
  });

  it("registers one command pair and dispatches both through one execution", async () => {
    const executionId = "123e4567-e89b-42d3-a456-426614174000";
    const snapshot = vi.fn(async () => "snapshot");
    const act = vi.fn(async () => "act");
    const executionRetiring = createDeferredCore();
    const close = vi.fn(async () => await executionRetiring.promise);
    const retiring = createDeferredCore();
    const stopEntered = createDeferredCore();
    const failure = new Error("availability stop failed");
    const stopWatching = vi.fn(() => {
      stopEntered.resolve();
      return retiring.promise;
    });
    const openExecution = vi.fn(async () => ({ snapshot, act, close }));
    const commands = registerProvider(openExecution, {
      capabilities: () => capabilityDescriptor(["screenshot", "left_click"]),
      watchAvailability: () => stopWatching,
    });

    expect(commands.map(({ command, cap, dangerous }) => ({ command, cap, dangerous }))).toEqual([
      { command: "screen.snapshot", cap: "screen", dangerous: false },
      { command: "computer.act", cap: "computer", dangerous: true },
    ]);

    const signal = new AbortController().signal;
    const context = { sendNodeEvent: vi.fn(), sessionKey: "session-1", signal };
    const paramsJSON = JSON.stringify({ executionId });
    await expect(commands[0]!.handle(paramsJSON, undefined, context)).resolves.toBe("snapshot");
    await expect(commands[1]!.handle(paramsJSON, undefined, context)).resolves.toBe("act");
    expect(openExecution).toHaveBeenCalledOnce();
    expect(openExecution).toHaveBeenCalledWith({ executionId, sessionKey: "session-1" });
    expect(snapshot).toHaveBeenCalledWith(paramsJSON, signal);
    expect(act).toHaveBeenCalledWith(paramsJSON, signal);

    const stop = commands[0]!.watchAvailability?.({ config: {} as never, env: {} }, vi.fn());
    const stopping = Promise.resolve(stop?.());
    let settled = false;
    const observed = stopping.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await stopEntered.promise;
      await vi.waitFor(() => expect(close).toHaveBeenCalledWith("node-host-stop"));
      retiring.reject(failure);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      executionRetiring.resolve();
      expect(await observed).toBe(failure);
      expect(stopWatching).toHaveBeenCalledOnce();
    } finally {
      retiring.resolve();
      executionRetiring.resolve();
      await Promise.allSettled([stopping, observed]);
    }
  });

  it("refuses a second mutating execution and closes only the exact host execution", async () => {
    const firstId = "123e4567-e89b-42d3-a456-426614174000";
    const secondId = "223e4567-e89b-42d3-a456-426614174000";
    const closes: string[] = [];
    const openExecution = vi.fn(async () => ({
      snapshot: vi.fn(async () => "snapshot"),
      act: vi.fn(async () => "act"),
      close: vi.fn(async (reason: string) => {
        closes.push(reason);
      }),
    }));
    const commands = registerProvider(openExecution, {
      capabilities: () => ({
        ...capabilityDescriptor(["start_recording", "stop_recording"]),
        features: { recording: true, agentCursor: false, multiDisplay: false },
      }),
    });
    const computer = commands.find((command) => command.command === "computer.act")!;

    await expect(
      computer.handle(JSON.stringify({ action: "start_recording", executionId: firstId })),
    ).resolves.toBe("act");
    await expect(
      computer.handle(JSON.stringify({ action: "stop_recording", executionId: secondId })),
    ).rejects.toThrow("COMPUTER_HOST_BUSY");
    expect(openExecution).toHaveBeenCalledOnce();

    await computer.handle(
      JSON.stringify({ action: "__close_execution", executionId: firstId, reason: "completion" }),
    );
    await expect(
      computer.handle(JSON.stringify({ action: "start_recording", executionId: secondId })),
    ).resolves.toBe("act");
    expect(openExecution).toHaveBeenCalledTimes(2);
    await commands.find((command) => command.command === "screen.snapshot")!.onDisconnect?.();
    expect(closes).toEqual(["completion", "gateway-disconnect"]);
  });
});
