import { expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { SessionHovercard } from "./session-hovercard-solid.tsx";
import "../styles/base.css";

it("keeps failure rows at the same spacing as the other compact sections", () => {
  const { container } = mountSolid(() => (
    <SessionHovercard
      row={{
        label: "Spacing proof",
        hasAutomation: false,
        hasActiveRun: false,
        workContext: { kind: "workspace", name: "openclaw", path: "/work/openclaw" },
        attention: {
          kind: "error",
          reason: "Run interrupted by a Gateway restart.",
          sourceSessionKey: "agent:main:spacing-proof",
        },
      }}
      pullRequests={{
        status: "ready",
        rateLimited: false,
        pullRequests: [],
        branch: {
          owner: "example",
          repo: "example",
          branch: "fix/spacing",
          additions: 1,
          deletions: 0,
        },
      }}
    />
  ));
  flush();
  const context = container.querySelector(".session-hovercard__context")!;
  const branch = container.querySelector(".session-hovercard__branch-row")!;
  const error = container.querySelector(".session-hovercard__error > span:last-child")!;
  const compactGap = branch.getBoundingClientRect().top - context.getBoundingClientRect().bottom;
  const errorGap = error.getBoundingClientRect().top - branch.getBoundingClientRect().bottom;
  expect(compactGap).toBeGreaterThan(0);
  expect(errorGap).toBe(compactGap);
});
