import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { buildMultiResult, buildProps } from "./view.test-support.tsx";
import { SessionsView } from "./view.tsx";
import "../../styles.css";

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

it("retains native label selection and undo without value writes during row metadata refreshes", async () => {
  await page.viewport(1440, 900);
  const result = buildMultiResult([
    { key: "agent:main:editing", label: "Original", kind: "direct", updatedAt: 2 },
    { key: "agent:main:sibling", label: "Sibling", kind: "direct", updatedAt: 1 },
  ]);
  const initial = {
    ...buildProps(result),
    expandedSessionKey: result.sessions[0]!.key,
    onPatch: vi.fn(),
  };
  const [current, setCurrent] = createSignal(initial);
  const view = mountSolid(() => <SessionsView {...current()} />);
  const input = view.container.querySelector<HTMLInputElement>(".session-overrides-grid input")!;
  await userEvent.click(input);
  await userEvent.keyboard("{End}x");
  expect(input.value).toBe("Originalx");
  input.setSelectionRange(2, 5);
  const setter = vi.spyOn(input, "value", "set");
  setCurrent((previous) => ({
    ...previous,
    refreshing: true,
    result: {
      ...result,
      sessions: [
        { ...result.sessions[0]!, kind: "group", unread: true },
        { ...result.sessions[1]!, label: "Updated sibling" },
      ],
    },
  }));
  flush();
  expect(view.container.querySelector(".session-overrides-grid input")).toBe(input);
  expect(input.value).toBe("Originalx");
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
  expect(setter).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("Updated sibling");
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(input.value).toBe("Original");
  expect(initial.onPatch).not.toHaveBeenCalled();
  setCurrent((previous) => ({ ...previous, loading: true }));
  flush();
  expect(input.disabled).toBe(true);
  expect(setter).not.toHaveBeenCalled();
  setCurrent((previous) => ({ ...previous, loading: false }));
  flush();
  expect(input.disabled).toBe(false);
  expect(setter).not.toHaveBeenCalled();
  setCurrent((previous) => ({
    ...previous,
    result: {
      ...result,
      sessions: [{ ...result.sessions[0]!, label: "Authoritative" }, result.sessions[1]!],
    },
  }));
  flush();
  expect(input.value).toBe("Authoritative");
  expect(setter).toHaveBeenCalledTimes(1);
});
