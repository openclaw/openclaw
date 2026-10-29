import { setImmediate as nextTurn } from "node:timers/promises";
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
import { trackCompletion } from "./plugin-instance.test-support.js";
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
) {
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
  return {
    commands,
    snapshot: commands[0]!,
    computer: commands[1]!,
    read: (id: string) => commands[0]!.handle(envelope(id)),
    act: (id: string, action: string) => commands[1]!.handle(envelope(id, action)),
    retire: (id: string, reason?: string) =>
      commands[1]!.handle(JSON.stringify({ executionId: id, action: "__close_execution", reason })),
    active: () => commands.map((command) => command.hasActiveWork?.()),
  };
}

const firstId = "123e4567-e89b-42d3-a456-426614174000";
const nextId = "223e4567-e89b-42d3-a456-426614174000";
const browserTarget = {
  browserRef: "browser-1",
  pageRef: "page-1",
  observationId: "observation-1",
  elementRef: "element-1",
};
const browserInput = (action: string, fields: Record<string, unknown> = {}) => ({
  action,
  ...browserTarget,
  ...fields,
});
const envelope = (executionId: string, action?: string) => JSON.stringify({ executionId, action });
const openMock = (close: Awaited<ReturnType<ComputerUseProvider["openExecution"]>>["close"]) =>
  vi.fn<ComputerUseProvider["openExecution"]>(async () => ({
    snapshot: async () => "snapshot",
    act: async () => "act",
    close,
  }));

describe("Computer Use wire contract", () => {
  it("accepts optional cursor coordinates from older paired nodes", () => {
    for (const receipt of [
      { ok: true },
      { ok: true, cursorX: -12.5 },
      { ok: true, cursorY: 4.25 },
      { ok: true, cursorX: -12.5, cursorY: 4.25 },
    ]) {
      expect(parseComputerActResult(receipt)).toEqual(receipt);
    }
  });

  it.each([{ cursorX: "12" }, { cursorY: null }, { unexpected: true }])(
    "rejects invalid receipt fields: %j",
    (fields) => {
      expect(() => parseComputerActResult({ ok: true, ...fields })).toThrow(
        "COMPUTER_CONTRACT_MISMATCH",
      );
    },
  );

  it("projects the canonical screen.snapshot result", () => {
    const result = {
      format: "jpeg",
      base64: "aGk=",
      displayFrameId: "frame-1",
      width: 100,
      height: 50,
      capturedAtMs: 42,
    };
    expect(parseScreenSnapshotResult({ ...result, ignored: true })).toEqual(result);
  });

  it("accepts the portable recording family without native path or helper inputs", () => {
    const resourceHandle = "openclaw:computer-resource:v1:123e4567-e89b-42d3-a456-426614174000";
    for (const input of [
      { action: "get_recording_state" },
      { action: "start_recording", recordVideo: true },
      { action: "stop_recording" },
      { action: "replay_trajectory", resourceHandle, delayMs: 25, stopOnError: false },
      browserInput("browser_set_input_files", { resourceHandles: [resourceHandle] }),
      browserInput("browser_download"),
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
      { action: "browser_set_input_files", ...browserTarget, files: ["/tmp/input.txt"] },
      { action: "browser_download", ...browserTarget, destinationRoot: "/tmp/downloads" },
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
    const observation = (count: number) => ({
      kind: "window",
      elements: Array.from({ length: count }, () => element),
    });
    const details = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`key-${index}`, index]));
    expect(
      parseComputerActResult({
        ok: true,
        observation: { ...observation(2_000), observationId: "observation-1" },
        details: details(64),
      }),
    ).toMatchObject({ ok: true });
    expect(() => parseComputerActResult({ ok: true, observation: observation(2_001) })).toThrow(
      "COMPUTER_CONTRACT_MISMATCH",
    );
    expect(() => parseComputerActResult({ ok: true, details: details(65) })).toThrow(
      "COMPUTER_CONTRACT_MISMATCH",
    );
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
      const openExecution = openMock(close);
      const { snapshot, read, retire, active } = registerProvider(openExecution);
      expect(active()).toEqual([false, false]);
      await read(firstId);
      expect(active()).toEqual([true, true]);
      const retiringFirst = retire(firstId);
      const openingNext = read(nextId);
      const retiringNext = retire(nextId);
      const laterSnapshot = read(laterId);
      const retiringLater = closeLater ? retire(laterId) : undefined;
      const later = trackCompletion(laterSnapshot);
      const laterClose = retiringLater && trackCompletion(retiringLater);
      const operations = Promise.all([
        retiringFirst,
        openingNext,
        retiringNext,
        laterSnapshot,
        ...(retiringLater ? [retiringLater] : []),
      ]);
      void operations.catch(() => {});
      try {
        firstClose.resolve();
        await nextTurn();
        expect(active()).toEqual([true, true]);
        expect(later.done).toBe(false);
        expect(laterClose?.done ?? false).toBe(false);
        nextClose.resolve();
        expect(await operations).toEqual([
          '{"ok":true}',
          "snapshot",
          '{"ok":true}',
          "snapshot",
          ...(closeLater ? ['{"ok":true}'] : []),
        ]);
        expect(active()).toEqual([!closeLater, !closeLater]);
      } finally {
        firstClose.resolve();
        nextClose.resolve();
        await Promise.allSettled([operations, later.promise, laterClose?.promise]);
        await snapshot.onDisconnect?.();
        expect(active()).toEqual([false, false]);
      }
    },
  );

  it("retains terminal close failure without confusing it with failed-open recovery", async () => {
    const openFailure = new Error("native driver startup failed");
    const closeFailure = new Error("native driver shutdown failed");
    const failedOpening =
      createDeferredCore<Awaited<ReturnType<ComputerUseProvider["openExecution"]>>>();
    const physicalClose = vi.fn(async () => {
      throw closeFailure;
    });
    let terminalClose: Promise<void> | undefined;
    const close = vi.fn(() => (terminalClose ??= physicalClose()));
    const openExecution = openMock(close).mockImplementationOnce(() => failedOpening.promise);
    const { read, retire, active } = registerProvider(openExecution);

    const opening = read(firstId);
    const closingFailedOpen = retire(firstId);
    expect(active()).toEqual([true, true]);
    const failedOpenResults = Promise.allSettled([opening, closingFailedOpen]);
    failedOpening.reject(openFailure);
    expect(await failedOpenResults).toEqual([
      { status: "rejected", reason: openFailure },
      { status: "rejected", reason: openFailure },
    ]);
    expect(active()).toEqual([false, false]);
    await expect(read(firstId)).resolves.toBe("snapshot");
    await expect(retire(firstId)).rejects.toBe(closeFailure);
    expect(active()).toEqual([true, true]);
    await expect(retire(nextId)).resolves.toBe('{"ok":true}');
    expect(close).toHaveBeenCalledOnce();

    await expect(retire(firstId)).rejects.toBe(closeFailure);
    await expect(read(nextId)).rejects.toBe(closeFailure);
    expect(physicalClose).toHaveBeenCalledOnce();
  });

  it("registers one command pair and dispatches both through one execution", async () => {
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
    const {
      commands,
      snapshot: snapshotCommand,
      computer,
    } = registerProvider(openExecution, {
      capabilities: () => capabilityDescriptor(["screenshot", "left_click"]),
      watchAvailability: () => stopWatching,
    });

    expect(commands.map(({ command, cap, dangerous }) => ({ command, cap, dangerous }))).toEqual([
      { command: "screen.snapshot", cap: "screen", dangerous: false },
      { command: "computer.act", cap: "computer", dangerous: true },
    ]);

    const signal = new AbortController().signal;
    const context = { sendNodeEvent: vi.fn(), sessionKey: "session-1", signal };
    const paramsJSON = envelope(firstId);
    await expect(snapshotCommand.handle(paramsJSON, undefined, context)).resolves.toBe("snapshot");
    await expect(computer.handle(paramsJSON, undefined, context)).resolves.toBe("act");
    expect(openExecution).toHaveBeenCalledOnce();
    expect(openExecution).toHaveBeenCalledWith({ executionId: firstId, sessionKey: "session-1" });
    expect(snapshot).toHaveBeenCalledWith(paramsJSON, signal);
    expect(act).toHaveBeenCalledWith(paramsJSON, signal);

    const stop = snapshotCommand.watchAvailability?.({ config: {} as never, env: {} }, vi.fn());
    const stopping = Promise.resolve(stop?.());
    const observed = trackCompletion(stopping.catch((error: unknown) => error));
    try {
      await stopEntered.promise;
      await vi.waitFor(() => expect(close).toHaveBeenCalledWith("node-host-stop"));
      retiring.reject(failure);
      await nextTurn();
      expect(observed.done).toBe(false);
      executionRetiring.resolve();
      expect(await observed.promise).toBe(failure);
    } finally {
      retiring.resolve();
      executionRetiring.resolve();
      await Promise.allSettled([stopping, observed.promise]);
    }
  });

  it("refuses a second mutating execution and closes only the exact host execution", async () => {
    const closes: string[] = [];
    const openExecution = openMock(async (reason) => {
      closes.push(reason);
    });
    const { snapshot, act, retire } = registerProvider(openExecution, {
      capabilities: () => ({
        ...capabilityDescriptor(["start_recording", "stop_recording"]),
        features: { recording: true, agentCursor: false, multiDisplay: false },
      }),
    });

    await expect(act(firstId, "start_recording")).resolves.toBe("act");
    await expect(act(nextId, "stop_recording")).rejects.toThrow("COMPUTER_HOST_BUSY");

    await retire(firstId, "completion");
    await expect(act(nextId, "start_recording")).resolves.toBe("act");
    await snapshot.onDisconnect?.();
    expect(closes).toEqual(["completion", "gateway-disconnect"]);
  });
});
