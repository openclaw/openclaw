import { expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { createContext, createGateway, mountPalette } from "../command-palette.test-support.ts";
import "../command-palette.tsx";
import "../../styles.css";

function shortcut() {
  const mac = navigator.platform.includes("Mac");
  const event = new KeyboardEvent("keydown", {
    key: "k",
    code: "KeyK",
    ctrlKey: !mac,
    metaKey: mac,
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(event);
  return event;
}

function expectSelection(input: HTMLTextAreaElement) {
  expect(input).toMatchObject({
    selectionStart: 1,
    selectionEnd: 4,
    selectionDirection: "backward",
  });
}

it("keeps palette keyboard editing and catalog work scoped across result navigation and publication", async () => {
  let namesRead = 0;
  let version = 0;
  let modelRequests = 0;
  const harness = createGateway(true, {
    methods: ["models.list"],
    request: async (method, params) => {
      if (method === "models.list") {
        modelRequests++;
        const requestVersion = version;
        const otherAgent =
          typeof params === "object" &&
          params !== null &&
          "agentId" in params &&
          params.agentId === "other";
        return {
          models: Array.from({ length: 512 }, (_, index) => ({
            provider: "fixture",
            id: "needle-" + index,
            get name() {
              if (!otherAgent) {
                namesRead++;
              }
              return "Needle " + requestVersion + " model " + String(index).padStart(3, "0");
            },
          })),
        };
      }
      return { results: [], sessions: [] };
    },
  });
  const { palette, provider } = await mountPalette(
    createContext(harness.gateway, async () => null),
  );
  onTestFinished(() => provider.remove());
  // One native edit keeps a deterministic undo target.
  palette.openPalette({
    value: "needl",
    selectionStart: 5,
    selectionEnd: 5,
    selectionDirection: "none",
  });
  await palette.updateComplete;
  const input = palette.querySelector<HTMLTextAreaElement>("textarea")!;
  input.focus();
  // Move to the end of this word with the platform's native editing shortcut.
  await userEvent.keyboard("{ControlOrMeta>}{ArrowRight}{/ControlOrMeta}e");
  expect(input.value).toBe("needle");
  await expect.poll(() => palette.textContent).toContain("Needle 0 model 000");
  // Rows can be stale during debounce; wait for keyboard navigation admission.
  await expect.poll(() => input.getAttribute("aria-activedescendant")).toBeTruthy();
  await palette.updateComplete;
  const rows = [...palette.querySelectorAll('[role="option"]')];
  const beforeActive = input.getAttribute("aria-activedescendant");
  input.setSelectionRange(1, 4, "backward");
  namesRead = 0;
  const nativeWrites = vi.spyOn(input, "value", "set");
  const beforeRequests = modelRequests;
  await userEvent.keyboard("{ArrowDown}");
  await palette.updateComplete;
  const navigationReads = namesRead;
  expectSelection(input);
  expect(input.getAttribute("aria-activedescendant")).not.toBe(beforeActive);
  expect([...palette.querySelectorAll('[role="option"]')]).toEqual(rows);
  expect(modelRequests).toBe(beforeRequests);
  expect(navigationReads).toBe(0);
  expect(nativeWrites).not.toHaveBeenCalled();
  namesRead = 0;
  await loadModelCatalog(harness.gateway.snapshot.client!, { agentId: "other" });
  await palette.updateComplete;
  expect(namesRead).toBe(0);
  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  version = 1;
  harness.emit("chat.metadata.changed", { agentId: "main" });
  await expect.poll(() => palette.textContent).toContain("Needle 1 model 000");
  expect(modelRequests).toBeGreaterThan(beforeRequests);
  expect(palette.querySelector("textarea")).toBe(input);
  expect(document.activeElement).toBe(input);
  expectSelection(input);
  expect(nativeWrites).not.toHaveBeenCalled();
  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  nativeWrites.mockRestore();
  await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");
  expect(input.value).toBe("needl");
  palette.remove();
  expect(shortcut().defaultPrevented).toBe(false);
  provider.append(palette);
  await palette.updateComplete;
  const restoredShortcut = shortcut();
  await palette.updateComplete;
  expect(restoredShortcut.defaultPrevented).toBe(true);
  expect(palette.isOpen).toBe(true);
});
