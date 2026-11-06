import { expect, it, vi } from "vitest";
import { createWorkspaceBootstrapFilePolicy } from "./workspace-bootstrap-policy.js";

vi.mock("node:path", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:path")>();
  // Exercise Windows relative-path output while filesystem containment stays native.
  return {
    ...original,
    default: {
      ...original,
      relative: original.win32.relative,
      sep: original.win32.sep,
    },
  };
});

it("admits a configured literal when the host returns Windows path separators", () => {
  const policy = createWorkspaceBootstrapFilePolicy({
    workspaceDir: "/workspace",
    config: {
      hooks: {
        internal: {
          entries: { "bootstrap-extra-files": { paths: ["team[1]/SOUL.md"] } },
        },
      },
    },
  });
  expect(policy.canRead("team[1]/SOUL.md")).toBe(true);
  expect(policy.canRead("team[2]/SOUL.md")).toBe(false);
  expect(policy.canWrite("team[1]/SOUL.md")).toBe(false);
});
