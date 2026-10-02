import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildClawRemovePlan: vi.fn(),
  applyClawRemovePlan: vi.fn(),
}));
vi.mock("../claws/lifecycle-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claws/lifecycle-state.js")>()),
  buildClawRemovePlan: mocks.buildClawRemovePlan,
  applyClawRemovePlan: mocks.applyClawRemovePlan,
}));

const { runClawsRemoveCommand } = await import("./claws-cli.runtime.js");

it("interrupts native Remove forward effects on SIGTERM and releases its listener", async () => {
  const planIntegrity = `sha256:${"a".repeat(64)}`;
  mocks.buildClawRemovePlan.mockResolvedValue({
    agentId: "worker",
    target: "worker",
    planIntegrity,
    actions: [],
    blockers: [],
  });
  const existingListeners = new Set(process.rawListeners("SIGTERM"));
  let observedCancellation = false;
  mocks.applyClawRemovePlan.mockImplementation(
    async (_plan: unknown, options: { assertForwardCurrent?: () => void }) => {
      const assertForwardCurrent = options.assertForwardCurrent;
      expect(assertForwardCurrent).toBeTypeOf("function");
      assertForwardCurrent?.();
      const newListeners = process
        .rawListeners("SIGTERM")
        .filter((listener) => !existingListeners.has(listener));
      expect(newListeners).toHaveLength(1);
      const onTerminate = newListeners[0] as (() => void) | undefined;
      onTerminate?.call(process);
      expect(() => assertForwardCurrent?.()).toThrow("Claw removal interrupted");
      observedCancellation = true;
      return {
        status: "partial",
        agentId: "worker",
        agentRemoved: false,
        packages: [],
        packageRefsReleased: 0,
      };
    },
  );
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

  await runClawsRemoveCommand("worker", { yes: true, planIntegrity, exactAgentId: true }, runtime);

  expect(observedCancellation).toBe(true);
  expect(runtime.exit).toHaveBeenCalledWith(1);
  expect(process.rawListeners("SIGTERM")).toEqual([...existingListeners]);
});
