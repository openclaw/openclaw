import { describe, expect, it } from "vitest";
import { isSidebarDraftOwnedBySelf } from "./app-sidebar-session-navigation-logic.ts";

describe("sidebar draft ownership presentation", () => {
  it("keeps owner drafts at normal emphasis", () => {
    expect(
      isSidebarDraftOwnedBySelf(
        { visibility: "draft", sharingRole: "owner", createdActor: undefined },
        undefined,
      ),
    ).toBe(true);
  });

  it("distinguishes an admin's own draft from another person's draft", () => {
    const ownDraft = {
      visibility: "draft" as const,
      sharingRole: "admin" as const,
      createdActor: { type: "human" as const, id: "admin" },
    };
    expect(isSidebarDraftOwnedBySelf(ownDraft, "admin")).toBe(true);
    expect(isSidebarDraftOwnedBySelf(ownDraft, "teammate")).toBe(false);
  });

  it("never marks a shared session as an owned draft", () => {
    expect(
      isSidebarDraftOwnedBySelf(
        {
          visibility: "shared",
          sharingRole: "owner",
          createdActor: { type: "human", id: "owner" },
        },
        "owner",
      ),
    ).toBe(false);
  });
});
