/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { registerSessionTitleTarget } from "./markdown-link-display.ts";
import { installSessionTitleRegistrar } from "./session-progress-hovercard-target.ts";

it("keeps mounted targets until bootstrap and releases cancelled targets", async () => {
  const removed = document.createElement("a");
  const retained = document.createElement("a");
  const label = document.createElement("span");
  const stopRemoved = registerSessionTitleTarget(removed, label);
  const stopRetained = registerSessionTitleTarget(retained, label);
  stopRemoved();
  const release = vi.fn();
  const register = vi.fn(() => release);
  installSessionTitleRegistrar(register);
  await Promise.resolve();
  expect(register).toHaveBeenCalledExactlyOnceWith(retained, label);
  stopRetained();
  expect(release).toHaveBeenCalledOnce();
});
