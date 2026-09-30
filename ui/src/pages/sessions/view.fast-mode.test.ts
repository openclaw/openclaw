/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { expect, it, vi } from "vitest";
import { buildProps, buildResult } from "./view.test-support.ts";
import { renderSessions } from "./view.ts";

it.each([true, "ultrafast"] as const)(
  "preserves the saved %s override until explicitly changed",
  async (fastMode) => {
    const key = "agent:main:main";
    const container = document.createElement("div");
    const onPatch = vi.fn();
    render(
      renderSessions({
        ...buildProps(buildResult({ key, kind: "direct", updatedAt: 1, fastMode })),
        expandedSessionKey: key,
        onPatch,
      }),
      container,
    );
    await Promise.resolve();
    const fast = expectDefined(
      container.querySelectorAll<HTMLSelectElement>("tbody select")[1],
      "speed override",
    );
    expect(fast.value).toBe(fastMode === "ultrafast" ? "ultrafast" : "on");
    expect([...fast.options].some((option) => option.value === "ultrafast")).toBe(
      fastMode === "ultrafast",
    );
    fast.value = "off";
    fast.dispatchEvent(new Event("change"));
    expect(onPatch).toHaveBeenCalledWith(key, { fastMode: false });
    render(nothing, container);
  },
);
