import { describe, expect, it, vi } from "vitest";
import { createPlanInputController } from "./tui-plan-input.js";

vi.mock("./components/selectors.js", () => ({
  createSearchableSelectList: vi.fn((items) => ({
    items,
    onSelect: undefined,
    onCancel: undefined,
  })),
}));

describe("tui plan input controller", () => {
  it("resolves selected options through the gateway", async () => {
    const resolvePlanInput = vi.fn().mockResolvedValue({ ok: true });
    const addSystem = vi.fn();
    const requestRender = vi.fn();
    const openOverlay = vi.fn();

    const controller = createPlanInputController({
      client: { resolvePlanInput } as never,
      chatLog: { addSystem } as never,
      tui: { requestRender } as never,
      openOverlay,
      closeOverlay: vi.fn(),
      setActivityStatus: vi.fn(),
    });

    controller.handleRequested({
      id: "prompt-1",
      runId: "run-1",
      sessionKey: "agent:main:main",
      createdAtMs: 1,
      expiresAtMs: 2,
      questions: [
        {
          header: "Scope",
          id: "scope",
          question: "Which scope?",
          options: [
            { label: "TUI only", description: "Recommended" },
            { label: "All clients", description: "Broader" },
          ],
        },
      ],
    });

    const selector = openOverlay.mock.calls[0]?.[0] as {
      onSelect?: (item: { value: string }) => void;
    };
    await selector.onSelect?.({ value: "0" });

    expect(resolvePlanInput).toHaveBeenCalledWith({
      id: "prompt-1",
      status: "answered",
      answers: {
        scope: {
          answer: "TUI only",
          source: "option",
          optionIndex: 0,
        },
      },
    });
    expect(addSystem).toHaveBeenCalledWith("plan input answered");
  });

  it("captures freeform answers via the editor path", async () => {
    const resolvePlanInput = vi.fn().mockResolvedValue({ ok: true });
    const addSystem = vi.fn();
    const openOverlay = vi.fn();
    const closeOverlay = vi.fn();

    const controller = createPlanInputController({
      client: { resolvePlanInput } as never,
      chatLog: { addSystem } as never,
      tui: { requestRender: vi.fn() } as never,
      openOverlay,
      closeOverlay,
      setActivityStatus: vi.fn(),
    });

    controller.handleRequested({
      id: "prompt-2",
      runId: "run-2",
      sessionKey: "agent:main:main",
      createdAtMs: 1,
      expiresAtMs: 2,
      questions: [
        {
          header: "Name",
          id: "name",
          question: "What should we call it?",
          options: [
            { label: "Plan mode", description: "Default" },
            { label: "Proposal mode", description: "Alternative" },
          ],
        },
      ],
    });

    const selector = openOverlay.mock.calls[0]?.[0] as {
      onSelect?: (item: { value: string }) => void;
    };
    selector.onSelect?.({ value: "__other__" });

    expect(controller.hasPendingFreeformAnswer()).toBe(true);
    await controller.consumeFreeformAnswer("custom mode");

    expect(resolvePlanInput).toHaveBeenCalledWith({
      id: "prompt-2",
      status: "answered",
      answers: {
        name: {
          answer: "custom mode",
          source: "other",
        },
      },
    });
    expect(closeOverlay).toHaveBeenCalled();
  });

  it("clears the pending prompt when it expires remotely", () => {
    const closeOverlay = vi.fn();
    const addSystem = vi.fn();

    const controller = createPlanInputController({
      client: { resolvePlanInput: vi.fn() } as never,
      chatLog: { addSystem } as never,
      tui: { requestRender: vi.fn() } as never,
      openOverlay: vi.fn(),
      closeOverlay,
      setActivityStatus: vi.fn(),
    });

    controller.handleRequested({
      id: "prompt-3",
      runId: "run-3",
      sessionKey: "agent:main:main",
      createdAtMs: 1,
      expiresAtMs: 2,
      questions: [
        {
          header: "Scope",
          id: "scope",
          question: "Which scope?",
          options: [
            { label: "TUI only", description: "Default" },
            { label: "All clients", description: "Alternative" },
          ],
        },
      ],
    });

    controller.handleResolved({
      id: "prompt-3",
      runId: "run-3",
      sessionKey: "agent:main:main",
      status: "expired",
      ts: Date.now(),
    });

    expect(closeOverlay).toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("plan input expired");
  });
});
