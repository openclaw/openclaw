// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parsePanelEmbedTarget } from "./target.ts";

describe("native panel document target", () => {
  it("keeps literal session identity and the selected task across URL encoding", () => {
    const query = new URLSearchParams({
      agent: "research",
      session: "agent:research:thread:release/notes",
      slot: "tasks",
      taskId: "task/a&b",
      resourceAutoOpenDismissed: "1",
    });
    expect(parsePanelEmbedTarget(query.toString())).toEqual({
      agentId: "research",
      sessionKey: "agent:research:thread:release/notes",
      panel: { id: "tasks", slot: "tasks", taskId: "task/a&b" },
      resourceAutoOpenDismissed: true,
    });
  });

  it.each([
    "?agent=main&slot=tasks",
    "?session=agent:main:one&slot=tasks",
    "?agent=other&session=agent:main:one&slot=tasks",
    "?agent=main&session=agent:main:one&slot=unknown",
    "?agent=main&session=agent:main:one&slot=chat",
    "?agent=main&session=agent:main:one&slot=plugin:missing-panel",
  ])(
    "refuses incomplete or conflicting targets instead of showing another session: %s",
    (query) => {
      expect(parsePanelEmbedTarget(query)).toBeNull();
    },
  );

  it("accepts plugin registration identities and metadata-only discovery", () => {
    const query = "?agent=main&session=agent:main:one&slot=";
    expect(parsePanelEmbedTarget(query + "plugin:notes/reader")?.panel?.slot).toBe(
      "plugin:notes/reader",
    );
    expect(parsePanelEmbedTarget(query + "picker")?.panel).toBeNull();
  });

  it("lets an explicit portal own its target instead of an environment startup hint", () => {
    const target = parsePanelEmbedTarget(
      "?agent=main&session=agent:main:one&slot=portal&portalId=portal-one&environmentId=worker-one",
    );
    expect(target?.panel).toEqual({ id: "portal", slot: "portal", portalId: "portal-one" });
  });

  it("hands reader URLs and workspace paths only to their owning panel", () => {
    const query =
      "?agent=main&session=agent:main:one&url=https%3A%2F%2Fforge.example%2Fitems%2F1&path=docs%2Freadme.md&slot=";
    expect(parsePanelEmbedTarget(query + "link-reader")).toMatchObject({
      url: "https://forge.example/items/1",
    });
    expect(parsePanelEmbedTarget(query + "workspace")).toMatchObject({ path: "docs/readme.md" });
    expect(parsePanelEmbedTarget(query + "tasks")).not.toHaveProperty("url");
    expect(parsePanelEmbedTarget(query + "link-reader")).not.toHaveProperty("path");
  });
});
