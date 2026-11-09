import { expect, it, vi } from "vitest";
import {
  registerComputerUseProvider,
  type ComputerUseProvider,
} from "./computer-use-registration.js";
import type { OpenClawPluginNodeHostCommand } from "./types.node-host.js";

const first = "123e4567-e89b-42d3-a456-426614174000";
const second = "223e4567-e89b-42d3-a456-426614174000";
function setup() {
  const snapshot = vi.fn(async (_params: unknown, _signal?: AbortSignal) => "snapshot");
  const act = vi.fn(async (_params: unknown, _signal?: AbortSignal) => "act");
  const close = vi.fn(async () => {});
  const open = vi.fn(async () => ({ snapshot, act, close }));
  const commands: OpenClawPluginNodeHostCommand[] = [];
  registerComputerUseProvider({ registerNodeHostCommand: (command) => commands.push(command) }, {
    id: "leased-fixture",
    label: "Fixture",
    isAvailable: () => true,
    openExecution: open,
    capabilities: () => ({
      contractVersion: 2,
      provider: { id: "fixture", label: "Fixture", generation: "one" },
      actions: ["screenshot", "mouse_move"],
      targets: ["screen"],
      deliveryModes: ["foreground"],
      observations: ["image"],
      features: { recording: false, agentCursor: false, multiDisplay: false },
    }),
  } satisfies ComputerUseProvider);
  const read = (executionId: string, executionTimeoutMs?: number) =>
    commands[0]!.handle(JSON.stringify({ executionId, executionTimeoutMs }));
  return { commands, snapshot, act, close, open, read };
}

it("expires an opt-in execution when the caller can no longer send cleanup", async () => {
  vi.useFakeTimers();
  const fixture = setup();
  try {
    const caller = new AbortController();
    await fixture.commands[0]!.handle(
      JSON.stringify({ executionId: first, executionTimeoutMs: 1000 }),
      undefined,
      { signal: caller.signal, sendNodeEvent: vi.fn() },
    );
    caller.abort(new Error("Caller disconnected"));
    expect(fixture.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.close).toHaveBeenCalledWith("execution-timeout");
    expect(fixture.commands[0]!.hasActiveWork?.()).toBe(false);
    await expect(fixture.read(second)).resolves.toBe("snapshot");
  } finally {
    await fixture.commands[0]!.onDisconnect?.();
    vi.useRealTimers();
  }
});

it("does not renew the first deadline or convert an existing unbounded slot", async () => {
  vi.useFakeTimers();
  const fixture = setup();
  try {
    await fixture.read(first, 1000);
    await vi.advanceTimersByTimeAsync(700);
    await fixture.read(first, 1000);
    await vi.advanceTimersByTimeAsync(300);
    expect(fixture.close).toHaveBeenCalledOnce();
    await fixture.read(second);
    await expect(fixture.read(second, 1000)).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.close).toHaveBeenCalledOnce();
  } finally {
    await fixture.commands[0]!.onDisconnect?.();
    vi.useRealTimers();
  }
});

it("aborts in-flight input and awaits physical close before releasing ownership", async () => {
  vi.useFakeTimers();
  const fixture = setup();
  let finishClose!: () => void;
  fixture.close.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
  );
  fixture.act.mockImplementationOnce(
    async (_params, signal) =>
      await new Promise<string>((_resolve, reject) => {
        signal!.addEventListener(
          "abort",
          () => reject(new Error("Execution aborted", { cause: signal!.reason })),
          { once: true },
        );
      }),
  );
  try {
    await fixture.read(first, 1000);
    const input = fixture.commands[1]!.handle(
      JSON.stringify({ executionId: first, action: "mouse_move" }),
    );
    const outcome = Promise.allSettled([input]);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await outcome)[0]?.status).toBe("rejected");
    expect(fixture.commands[0]!.hasActiveWork?.()).toBe(true);
    finishClose();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.commands[0]!.hasActiveWork?.()).toBe(false);
  } finally {
    finishClose?.();
    await fixture.commands[0]!.onDisconnect?.();
    vi.useRealTimers();
  }
});

it("rejects malformed or changed deadlines before admitting work", async () => {
  const fixture = setup();
  for (const params of [
    { executionTimeoutMs: 1000 },
    { executionId: first, executionTimeoutMs: 0 },
    { executionId: first, executionTimeoutMs: 30_001 },
    { executionId: first, executionTimeoutMs: 1000.5 },
  ]) {
    await expect(fixture.commands[0]!.handle(JSON.stringify(params))).rejects.toThrow(
      "COMPUTER_INVALID_REQUEST",
    );
  }
  expect(fixture.open).not.toHaveBeenCalled();
  try {
    await fixture.read(first, 1000);
    await expect(fixture.read(first, 2000)).rejects.toThrow("deadline");
  } finally {
    await fixture.commands[0]!.onDisconnect?.();
  }
});

it("retains failed physical cleanup instead of admitting another execution", async () => {
  vi.useFakeTimers();
  const fixture = setup();
  fixture.close.mockRejectedValue(new Error("physical close failed"));
  try {
    await fixture.read(first, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.commands[0]!.hasActiveWork?.()).toBe(true);
    await expect(fixture.read(second)).rejects.toThrow("physical close failed");
  } finally {
    fixture.close.mockResolvedValue(undefined);
    await fixture.commands[0]!.onDisconnect?.();
    vi.useRealTimers();
  }
});

it("keeps the deadline active while an explicit physical close is pending", async () => {
  vi.useFakeTimers();
  const fixture = setup();
  let finishClose!: () => void;
  fixture.close.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
  );
  try {
    await fixture.read(first, 1000);
    const signal = fixture.snapshot.mock.calls[0]![1]!;
    const closing = fixture.commands[1]!.handle(
      JSON.stringify({ executionId: first, action: "__close_execution" }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal.aborted).toBe(true);
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.commands[0]!.hasActiveWork?.()).toBe(true);
    finishClose();
    await closing;
    expect(fixture.commands[0]!.hasActiveWork?.()).toBe(false);
  } finally {
    finishClose?.();
    await fixture.commands[0]!.onDisconnect?.();
    vi.useRealTimers();
  }
});

it("requires an existing execution only when requested and validates the flag before acquiring", async () => {
  const fixture = setup();
  for (const params of [
    { action: "mouse_move", requireExistingExecution: true },
    { executionId: first, action: "mouse_move", requireExistingExecution: "true" },
  ]) {
    await expect(fixture.commands[1]!.handle(JSON.stringify(params))).rejects.toThrow(
      "COMPUTER_INVALID_REQUEST",
    );
  }
  await expect(
    fixture.commands[0]!.handle(
      JSON.stringify({ executionId: first, requireExistingExecution: true }),
    ),
  ).rejects.toThrow("COMPUTER_INVALID_REQUEST");
  await expect(
    fixture.commands[1]!.handle(
      JSON.stringify({ executionId: first, action: "mouse_move", requireExistingExecution: true }),
    ),
  ).rejects.toThrow("COMPUTER_EXECUTION_EXPIRED");
  expect(fixture.open).not.toHaveBeenCalled();
  try {
    await fixture.read(first, 1000);
    await expect(
      fixture.commands[1]!.handle(
        JSON.stringify({
          executionId: first,
          action: "mouse_move",
          requireExistingExecution: true,
        }),
      ),
    ).resolves.toBe("act");
  } finally {
    await fixture.commands[0]!.onDisconnect?.();
  }
});
