import { expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { SessionHovercard } from "./session-hovercard-solid.tsx";
import "../styles/base.css";

it("separates the top block and following sections with fixed gaps", () => {
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
  const top = container.querySelector(".session-hovercard__top")!;
  const header = container.querySelector(".session-hovercard__section--header")!;
  const context = container.querySelector(".session-hovercard__section--metadata")!;
  const error = container.querySelector(".session-hovercard__error")!;
  expect(context.getBoundingClientRect().top - header.getBoundingClientRect().bottom).toBe(8);
  expect(error.getBoundingClientRect().top - top.getBoundingClientRect().bottom).toBe(16);
});
