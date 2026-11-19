import { expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../loading/bundled-dir.js", () => ({ resolveBundledSkillsDir: () => undefined }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      warn,
    }),
  };
});

import { buildWorkspaceSkillReadiness, buildWorkspaceSkillStatus } from "./status.js";

it("warns once when the bundled skills directory cannot be resolved", () => {
  const options = {
    config: { plugins: { enabled: false } },
    managedSkillsDir: "/tmp/missing-bundled-managed",
  };
  buildWorkspaceSkillReadiness("/tmp/missing-bundled-status", options);
  buildWorkspaceSkillStatus("/tmp/missing-bundled-status", options);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    "Bundled skills directory could not be resolved; built-in skills may be missing.",
  );
});
