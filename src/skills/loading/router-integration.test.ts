import { describe, expect, it, vi } from "vitest";
import { resolveSkillRoute } from "./router-integration.js";
import { registerSkillRouter } from "./router-registry.js";

describe("resolveSkillRoute", () => {
  it("passes structured routing context to the configured router", async () => {
    const route = vi.fn(async () => ({ mode: "nomatch" as const }));
    registerSkillRouter("structured-context-router", () => ({
      name: "structured-context-router",
      route,
    }));

    await resolveSkillRoute({
      routerName: "structured-context-router",
      resolvedSkills: [
        {
          name: "github",
          description: "GitHub workflows",
          filePath: "/tmp/skills/github/SKILL.md",
        },
      ],
      query: "do that",
      recentMessages: [{ role: "user", content: "Review a GitHub PR.", timestamp: 1 }],
    });

    expect(route).toHaveBeenCalledWith(
      "do that",
      [
        {
          name: "github",
          description: "GitHub workflows",
          filePath: "/tmp/skills/github/SKILL.md",
        },
      ],
      {
        recentMessages: [{ role: "user", text: "Review a GitHub PR." }],
      },
    );
  });
});
