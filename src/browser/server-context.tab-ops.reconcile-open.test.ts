import { describe, expect, it } from "vitest";
import { reconcileOpenedTabCandidate } from "./server-context.tab-ops.js";

describe("reconcileOpenedTabCandidate", () => {
  it("returns the original tab when the created target still exists", () => {
    const result = reconcileOpenedTabCandidate({
      createdTargetId: "created",
      requestedUrl: "https://x.com/home",
      tabs: [
        {
          targetId: "created",
          title: "Home / X",
          url: "https://x.com/home",
          type: "page",
        },
      ],
    });

    expect(result?.targetId).toBe("created");
  });

  it("reconciles to a unique matching url when the created target disappears", () => {
    const result = reconcileOpenedTabCandidate({
      createdTargetId: "stale",
      requestedUrl: "https://x.com/home",
      tabs: [
        {
          targetId: "resolved",
          title: "Home / X",
          url: "https://x.com/home",
          type: "page",
        },
        {
          targetId: "other",
          title: "Notifications / X",
          url: "https://x.com/notifications",
          type: "page",
        },
      ],
    });

    expect(result?.targetId).toBe("resolved");
  });

  it("falls back to the only remaining page tab when there is no unique url match", () => {
    const result = reconcileOpenedTabCandidate({
      createdTargetId: "stale",
      requestedUrl: "https://mail.google.com/mail/u/0/#inbox",
      tabs: [
        {
          targetId: "remaining",
          title: "Inbox",
          url: "https://mail.google.com/mail/u/0/#label/updates",
          type: "page",
        },
      ],
    });

    expect(result?.targetId).toBe("remaining");
  });

  it("fails closed when multiple page tabs remain ambiguous", () => {
    const result = reconcileOpenedTabCandidate({
      createdTargetId: "stale",
      requestedUrl: "https://mail.google.com/mail/u/0/#inbox",
      tabs: [
        {
          targetId: "a",
          title: "Inbox A",
          url: "https://mail.google.com/mail/u/0/#label/updates",
          type: "page",
        },
        {
          targetId: "b",
          title: "Inbox B",
          url: "https://mail.google.com/mail/u/0/#label/promotions",
          type: "page",
        },
      ],
    });

    expect(result).toBeNull();
  });
});
