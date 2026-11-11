import { aroundEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  createSidebarContextLifecycle,
  disposeSidebarContextLifecycles,
} from "./app-sidebar-context-lifecycle.ts";
import { createApplicationGateway } from "./application-context-fixtures.ts";
import { createStorageMock } from "./storage.ts";
import { beginUiLeakCheck } from "./unit-leak-guard.ts";

aroundEach(async (runTest) => {
  const root = document.documentElement;
  const original = root.getAttribute("style");
  const preserved = "--fixture-preserved: 11px;";
  root.setAttribute("style", preserved);
  const check = beginUiLeakCheck();
  try {
    await runTest();
  } finally {
    const restored = root.getAttribute("style");
    const leaks = check();
    if (original === null) {
      root.removeAttribute("style");
    } else {
      root.setAttribute("style", original);
    }
    expect(restored).toBe(preserved);
    expect(leaks).toEqual([]);
  }
});

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
});

it.each([false, true])(
  "retires nested contexts after test cleanup (early disposal: %s)",
  (earlyDisposal) => {
    const { gateway } = createApplicationGateway();
    const agents = { state: { agentsList: null }, subscribe: () => () => {} };
    createSidebarContextLifecycle(gateway, agents, "main");
    createSidebarContextLifecycle(gateway, agents, "other");
    expect(document.documentElement.getAttribute("style")).not.toBe("--fixture-preserved: 11px;");
    if (earlyDisposal) {
      disposeSidebarContextLifecycles();
      disposeSidebarContextLifecycles();
    }
  },
);
