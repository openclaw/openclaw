/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillWorkshopProposal } from "../../lib/skill-workshop/index.ts";
import { createSkillWorkshopHistoryScanState } from "./state.ts";
import type { SkillWorkshopProps } from "./view-types.ts";
import { renderSkillWorkshop } from "./view.ts";

const originalPointerEvent = globalThis.PointerEvent;
let container: HTMLDivElement;

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

function pointer(type: string, pointerId: number, clientX: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX,
    pointerId,
    pointerType: "touch",
  });
}

const proposal: SkillWorkshopProposal = {
  key: "proposal-1",
  slug: "proposal-1",
  name: "Proposal",
  oneLine: "Queue resize fixture",
  body: "## Workflow\n- Test",
  status: "pending",
  version: 1,
  revisionHash: null,
  createdAt: 0,
  recencyGroup: "today",
  ageLabel: "now",
  supportFiles: [],
  isNew: false,
};

function createProps(): SkillWorkshopProps {
  return {
    loading: false,
    error: null,
    inspectingKey: null,
    proposals: [proposal],
    selectedKey: proposal.key,
    statusFilter: "pending",
    query: "",
    filePreviewKey: null,
    filePreviewQuery: "",
    queueWidth: 360,
    mode: "board",
    actionBusy: null,
    actionNotice: null,
    revisionKey: null,
    revisionDraft: "",
    assistantName: "OpenClaw",
    workshopAgentName: "Research",
    selfLearning: null,
    historyScan: createSkillWorkshopHistoryScanState(),
    counts: { all: 1, pending: 1, applied: 0, rejected: 0, quarantined: 0, stale: 0 },
    onStatusFilterChange: vi.fn(),
    onRetry: vi.fn(),
    onQueryChange: vi.fn(),
    onFilePreviewQueryChange: vi.fn(),
    onQueueWidthChange: vi.fn(),
    onModeChange: vi.fn(),
    onSelect: vi.fn(),
    onPrev: vi.fn(),
    onNext: vi.fn(),
    onApply: vi.fn(),
    onEvaluate: vi.fn(),
    onRevise: vi.fn(),
    onReject: vi.fn(),
    onRevisionDraftChange: vi.fn(),
    onRevisionCancel: vi.fn(),
    onRevisionSubmit: vi.fn(),
    onPreviewFile: vi.fn(),
    onClosePreview: vi.fn(),
    onSelfLearningToggle: vi.fn(),
    onHistoryScan: vi.fn(),
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(nothing, container);
  container.remove();
  document.body.style.removeProperty("cursor");
  document.body.style.removeProperty("user-select");
  if (originalPointerEvent) {
    Object.defineProperty(globalThis, "PointerEvent", {
      configurable: true,
      value: originalPointerEvent,
    });
  } else {
    delete (globalThis as Partial<typeof globalThis>).PointerEvent;
  }
  vi.restoreAllMocks();
});

describe("Skill Workshop queue resize", () => {
  it("keeps the gesture owned by its initiating pointer", () => {
    if (!globalThis.PointerEvent) {
      Object.defineProperty(globalThis, "PointerEvent", {
        configurable: true,
        value: TestPointerEvent as typeof PointerEvent,
      });
    }
    const props = createProps();
    render(renderSkillWorkshop(props), container);
    const resizer = container.querySelector<HTMLElement>(".sw-queue-resizer");
    expect(resizer).not.toBeNull();

    const capturedPointers = new Set<number>();
    const setPointerCapture = vi.fn((pointerId) => capturedPointers.add(pointerId));
    if (resizer) {
      resizer.setPointerCapture = setPointerCapture;
      resizer.hasPointerCapture = vi.fn((pointerId) => capturedPointers.has(pointerId));
      resizer.releasePointerCapture = vi.fn((pointerId) => capturedPointers.delete(pointerId));
    }

    resizer?.dispatchEvent(pointer("pointerdown", 7, 400));
    const foreignDown = pointer("pointerdown", 8, 450);
    resizer?.dispatchEvent(foreignDown);
    window.dispatchEvent(pointer("pointermove", 8, 500));
    window.dispatchEvent(pointer("pointerup", 8, 500));

    expect(foreignDown.defaultPrevented).toBe(true);
    expect(props.onQueueWidthChange).not.toHaveBeenCalled();

    window.dispatchEvent(pointer("pointermove", 7, 460));
    expect(props.onQueueWidthChange).toHaveBeenLastCalledWith(420);

    capturedPointers.delete(7);
    resizer?.dispatchEvent(pointer("lostpointercapture", 7, 460));
    window.dispatchEvent(pointer("pointermove", 7, 500));
    expect(props.onQueueWidthChange).toHaveBeenCalledOnce();

    resizer?.dispatchEvent(pointer("pointerdown", 8, 450));
    expect(setPointerCapture).toHaveBeenLastCalledWith(8);
    window.dispatchEvent(pointer("pointerup", 8, 450));
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("cleans an active gesture when the board pane is replaced", () => {
    if (!globalThis.PointerEvent) {
      Object.defineProperty(globalThis, "PointerEvent", {
        configurable: true,
        value: TestPointerEvent as typeof PointerEvent,
      });
    }
    const props = createProps();
    render(renderSkillWorkshop(props), container);
    const resizer = container.querySelector<HTMLElement>(".sw-queue-resizer");
    expect(resizer).not.toBeNull();

    const capturedPointers = new Set<number>();
    if (resizer) {
      resizer.setPointerCapture = vi.fn((pointerId) => capturedPointers.add(pointerId));
      resizer.hasPointerCapture = vi.fn((pointerId) => capturedPointers.has(pointerId));
      resizer.releasePointerCapture = vi.fn((pointerId) => capturedPointers.delete(pointerId));
    }

    document.body.style.cursor = "wait";
    document.body.style.userSelect = "text";
    resizer?.dispatchEvent(pointer("pointerdown", 7, 400));
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    try {
      props.mode = "today";
      render(renderSkillWorkshop(props), container);

      expect(document.body.style.cursor).toBe("wait");
      expect(document.body.style.userSelect).toBe("text");
      window.dispatchEvent(pointer("pointermove", 7, 460));
      expect(props.onQueueWidthChange).not.toHaveBeenCalled();
    } finally {
      window.dispatchEvent(new Event("blur"));
    }
  });

  it("cleans an active gesture when the view is unmounted", () => {
    if (!globalThis.PointerEvent) {
      Object.defineProperty(globalThis, "PointerEvent", {
        configurable: true,
        value: TestPointerEvent as typeof PointerEvent,
      });
    }
    const props = createProps();
    render(renderSkillWorkshop(props), container);
    const resizer = container.querySelector<HTMLElement>(".sw-queue-resizer");
    expect(resizer).not.toBeNull();

    const capturedPointers = new Set<number>();
    if (resizer) {
      resizer.setPointerCapture = vi.fn((pointerId) => capturedPointers.add(pointerId));
      resizer.hasPointerCapture = vi.fn((pointerId) => capturedPointers.has(pointerId));
      resizer.releasePointerCapture = vi.fn((pointerId) => capturedPointers.delete(pointerId));
    }

    document.body.style.cursor = "wait";
    document.body.style.userSelect = "text";
    resizer?.dispatchEvent(pointer("pointerdown", 7, 400));

    try {
      render(nothing, container);

      expect(document.body.style.cursor).toBe("wait");
      expect(document.body.style.userSelect).toBe("text");
      window.dispatchEvent(pointer("pointermove", 7, 460));
      expect(props.onQueueWidthChange).not.toHaveBeenCalled();
    } finally {
      window.dispatchEvent(new Event("blur"));
    }
  });
});
