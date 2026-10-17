import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { convertGrokBotRecipe, parseGrokBotRecipe } from "../extensions/grok-bot-import/api.js";
import { buildGatewayClawAddPlan } from "../src/claws/gateway-add-plan.js";
import { buildClawProject } from "../src/claws/project-build.js";
import { readClawManifestFile } from "../src/claws/reader.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());
function recipeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    profile: {
      name: "Research Buddy",
      description: "Research public sources. Never contact anyone.",
    },
    memory: [],
    skills: [],
    routines: [],
    plugins: [],
    ...overrides,
  });
}

describe("Grok Bot native Claw contract", () => {
  it("plans first-run instructions, memory, and the bot's display identity through native Claw add", async () => {
    const root = tempDirs.make("grok-install-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(root, "state"));
    const converted = await convertGrokBotRecipe({
      recipe: parseGrokBotRecipe(
        recipeJson({
          profile: {
            name: "Stalk Bot",
            description: "Research competitors.",
            avatarShape: "hex",
            avatarColor: "violet",
          },
          memory: [{ kind: "profile", content: "Remember the research scope." }],
          skills: [
            {
              name: "stalk-setup",
              description: "Set up research.",
              content: "Ask which competitors to follow.",
            },
          ],
          gettingStarted: { skill: "stalk-setup" },
        }),
      ),
      destination: join(root, "claw"),
    });
    const source = await readClawManifestFile(converted.packageRoot);
    expect(source.ok, JSON.stringify(source.diagnostics)).toBe(true);
    if (!source.ok) {
      throw new Error("Expected a readable Claw");
    }
    const config: OpenClawConfig = { agents: { entries: {} } };
    const plan = await buildGatewayClawAddPlan(source, { config, sourceMcpServers: {} });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "bootstrap", id: "BOOTSTRAP.md" }),
    );
    const bootstrapAction = plan.actions.find((action) => action.kind === "bootstrap");
    expect(bootstrapAction?.source).toBe(join(converted.packageRoot, "BOOTSTRAP.md"));
    expect(await readFile(bootstrapAction!.source!, "utf8")).toContain(
      "skills/stalk-setup/SKILL.md",
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", id: "MEMORY.md" }),
    );
    expect(plan.agent.config.identity).toMatchObject({
      name: "Stalk Bot",
      avatar: "assets/grok-bot-avatar.svg",
    });
  });

  it("marks unavailable owner source data as partial without inventing memory", async () => {
    const recipe = parseGrokBotRecipe(
      recipeJson({
        sourceLimitations: [
          { code: "source_memory_unavailable", message: "Injected source status." },
        ],
        skills: [
          { name: "research", description: "Research sources.", content: "Check public sources." },
        ],
      }),
    );
    expect(recipe.sourceLimitations).toBeUndefined();
    recipe.sourceLimitations = [
      {
        code: "source_memory_unavailable",
        message: "Grok did not provide this bot's saved memory.",
      },
      {
        code: "source_integration_requirements_unavailable",
        message: "Grok did not provide this bot's integration requirements.",
      },
    ];
    const result = await convertGrokBotRecipe({
      recipe,
      destination: join(tempDirs.make("grok-partial-"), "claw"),
    });
    expect(result.completeness).toBe("partial");
    expect(result.warnings).toEqual(recipe.sourceLimitations);
    expect(result.counts).toEqual({ memories: 0, skills: 1, routines: 0, plugins: 0 });
    const read = await readClawManifestFile(result.packageRoot);
    expect(read.ok, JSON.stringify(read.diagnostics)).toBe(true);
    if (!read.ok) {
      throw new Error("Expected a readable Claw");
    }
    expect(read.manifest.workspace?.files?.some((file) => file.path === "MEMORY.md")).toBe(false);
    await expect(readFile(join(result.packageRoot, "workspace/MEMORY.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const notes = await readFile(join(result.packageRoot, "workspace/GROK-IMPORT.md"), "utf8");
    for (const limitation of recipe.sourceLimitations) {
      expect(notes).toContain(limitation.code);
      expect(notes).toContain(limitation.message);
    }
    expect(notes).toContain("available");
    expect(notes).not.toContain("memories, and skills were translated");
    const bootstrap = await readFile(join(result.packageRoot, "BOOTSTRAP.md"), "utf8");
    expect(bootstrap).toContain("incomplete");
    expect(bootstrap).toContain("GROK-IMPORT.md");
    expect(bootstrap).toContain("before claiming");
  });

  it("preserves a verified custom avatar image ahead of generated shape metadata", async () => {
    const root = tempDirs.make("grok-photo-");
    const recipe = parseGrokBotRecipe(
      recipeJson({
        profile: { name: "Photo bot", description: "Research.", avatarShape: "unsupported" },
        avatarImage: { bytes: [1, 2], extension: "exe" },
      }),
    );
    expect(recipe.avatarImage).toBeUndefined();
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA9sAAAAASUVORK5CYII=",
      "base64",
    );
    recipe.avatarImage = { bytes: image, extension: "png" };
    const result = await convertGrokBotRecipe({ recipe, destination: join(root, "claw") });
    expect(result.warnings).toEqual([]);
    const read = await readClawManifestFile(result.packageRoot);
    expect(read.ok, JSON.stringify(read.diagnostics)).toBe(true);
    if (!read.ok) {
      throw new Error("Expected a readable Claw");
    }
    expect(read.manifest.agent.identity?.avatar).toBe("assets/grok-bot-avatar.png");
    expect(
      await readFile(join(result.packageRoot, "workspace/assets/grok-bot-avatar.png")),
    ).toEqual(image);
    const built = await buildClawProject(result.packageRoot, join(root, "photo-bot.tgz"));
    expect(built.integrity).toMatch(/^sha256:/);
  });

  it("preserves the canonical profile title and gives equal-name hosted bots distinct identities", async () => {
    const root = tempDirs.make("grok-identity-");
    const recipe = parseGrokBotRecipe(
      recipeJson({
        profile: {
          name: "Research Buddy",
          title: "Competitor Intelligence Desk",
          description: "Research public sources.",
        },
      }),
    );
    const first = await convertGrokBotRecipe({
      recipe,
      destination: join(root, "first"),
      identitySuffix: "0123456789ab",
    });
    const second = await convertGrokBotRecipe({
      recipe,
      destination: join(root, "second"),
      identitySuffix: "fedcba987654",
    });
    const reads = await Promise.all([
      readClawManifestFile(first.packageRoot),
      readClawManifestFile(second.packageRoot),
    ]);
    expect(reads.every((read) => read.ok)).toBe(true);
    const ids = reads.map((read) => (read.ok ? read.manifest.agent.id : "invalid"));
    expect(ids).toEqual(["research-buddy-0123456789ab", "research-buddy-fedcba987654"]);
    const firstRead = reads[0];
    if (!firstRead?.ok) {
      throw new Error("Expected a readable Claw");
    }
    expect(firstRead.manifest.agent.description).toBe("Competitor Intelligence Desk");
    expect(firstRead.clawMarkdownBody?.toString()).toContain("Research public sources.");
    await expect(
      convertGrokBotRecipe({
        recipe,
        destination: join(root, "unsafe"),
        identitySuffix: "../../escape",
      }),
    ).rejects.toThrow(/identity suffix/);
  });

  it("creates an inspectable and buildable native Claw when the bot has no instructions", async () => {
    const root = tempDirs.make("grok-convert-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(root, "state"));
    const destination = join(root, "claw");
    const result = await convertGrokBotRecipe({
      recipe: parseGrokBotRecipe(
        recipeJson({ profile: { name: "Research Buddy", description: "" } }),
      ),
      destination,
    });
    const read = await readClawManifestFile(destination);
    expect(read.ok, JSON.stringify(read.diagnostics)).toBe(true);
    if (!read.ok) {
      throw new Error("Expected a readable Claw");
    }
    expect(read.manifest.agent.id).toBe("research-buddy");
    expect(read.manifest.agent.name).toBe("Research Buddy");
    expect(read.clawMarkdownBody?.toString().trim() ?? "").toBe("");
    expect(read.manifest.cronJobs).toEqual([]);
    expect(read.manifest.packages).toEqual([]);
    expect(result.counts).toEqual({ memories: 0, skills: 0, routines: 0, plugins: 0 });
    expect(result.completeness).toBe("complete");
    const plan = await buildGatewayClawAddPlan(read, {
      config: { agents: { entries: {} } },
      sourceMcpServers: {},
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.some((action) => action.id === "SOUL.md")).toBe(false);
    const built = await buildClawProject(destination, join(root, "research-buddy.tgz"));
    expect(built.integrity).toMatch(/^sha256:/);
    expect(
      JSON.parse(await readFile(join(destination, "package.json"), "utf8")).openclaw.claw,
    ).toBe("CLAW.md");
  });

  it("preserves memories and skill bodies, links first-run setup, and keeps routines and plugins for review", async () => {
    const destination = join(tempDirs.make("grok-content-"), "claw");
    const existingSkill =
      "---\nname: source-check\ndescription: Check the source.\n---\n\nKeep these exact bytes.\n";
    const result = await convertGrokBotRecipe({
      recipe: parseGrokBotRecipe(
        recipeJson({
          memory: [
            {
              kind: "profile",
              createdAt: "2026-01-02T12:00:00Z",
              content: "Our product is a bicycle.",
            },
          ],
          skills: [
            {
              name: "Setup: research",
              description: "Ask what: when?\nThen start.",
              content: "Ask the user's company.\n",
            },
            { name: "Source check", description: "Original metadata", content: existingSkill },
          ],
          routines: [
            {
              name: "Daily report",
              slug: "daily-report",
              description: "Disabled until configured.",
              content: "Report at 9am, in the user's timezone.\n",
            },
          ],
          plugins: [
            {
              name: "Example mail",
              pluginId: "grok-mail-id",
              description: "Create research inboxes.",
            },
          ],
          gettingStarted: { skill: "Setup: research" },
        }),
      ),
      destination,
    });
    const read = await readClawManifestFile(destination);
    expect(read.ok, JSON.stringify(read.diagnostics)).toBe(true);
    if (!read.ok) {
      throw new Error("Expected a readable Claw");
    }
    expect(read.manifest.cronJobs).toEqual([]);
    expect(read.manifest.packages).toEqual([]);
    expect(read.manifest.mcpServers).toEqual({});
    expect(await readFile(join(destination, "workspace/MEMORY.md"), "utf8")).toContain(
      "Our product is a bicycle.",
    );
    const generatedSkill = await readFile(
      join(destination, "workspace/skills/setup-research/SKILL.md"),
      "utf8",
    );
    expect(generatedSkill.endsWith("Ask the user's company.\n")).toBe(true);
    expect(parse(generatedSkill.split("---\n")[1] ?? "").description).toBe(
      "Ask what: when?\nThen start.",
    );
    expect(
      await readFile(join(destination, "workspace/skills/source-check/SKILL.md"), "utf8"),
    ).toBe(existingSkill);
    expect(
      await readFile(join(destination, "workspace/routines/daily-report/ROUTINE.md"), "utf8"),
    ).toBe("Report at 9am, in the user's timezone.\n");
    expect(await readFile(join(destination, "BOOTSTRAP.md"), "utf8")).toContain(
      "skills/setup-research/SKILL.md",
    );
    const setup = await readFile(join(destination, "workspace/GROK-IMPORT.md"), "utf8");
    expect(setup).toContain("grok-mail-id");
    expect(setup).toContain("Create research inboxes.");
    expect(setup).toContain("No routines are enabled");
    expect(result.requiresReview).toEqual({
      routines: ["Daily report"],
      plugins: ["Example mail"],
    });
    expect(result.counts).toEqual({ memories: 1, skills: 2, routines: 1, plugins: 1 });
    expect(result.completeness).toBe("complete");
  });

  it("preserves colliding and path-like skill names in distinct portable files", async () => {
    const destination = join(tempDirs.make("grok-paths-"), "claw");
    await convertGrokBotRecipe({
      recipe: parseGrokBotRecipe(
        recipeJson({
          profile: { name: "123 analyst", description: "Research." },
          skills: ["../Read News", "read-news", "CON"].map((name, i) => ({
            name,
            description: "Read news.",
            content: `Original body ${i}`,
          })),
        }),
      ),
      destination,
    });
    const read = await readClawManifestFile(destination);
    expect(read.ok, JSON.stringify(read.diagnostics)).toBe(true);
    if (!read.ok) {
      throw new Error("Expected a readable Claw");
    }
    expect(read.manifest.agent.id).toBe("bot-123-analyst");
    expect((await readdir(join(destination, "workspace/skills"))).toSorted()).toEqual([
      "read-news",
      "read-news-2",
      "skill-con",
    ]);
    expect(
      await readFile(join(destination, "workspace/skills/read-news/SKILL.md"), "utf8"),
    ).toContain("Original body 0");
    expect(
      await readFile(join(destination, "workspace/skills/read-news-2/SKILL.md"), "utf8"),
    ).toContain("Original body 1");
  });

  it("imports the bot's own hex avatar as a managed image and diagnoses unsupported icon metadata", async () => {
    const root = tempDirs.make("grok-avatar-");
    const destination = join(root, "known");
    const profile = {
      name: "Violet researcher",
      description: "Research.",
      avatarColor: "#9159FE",
      avatarShape: "hex",
    };
    const result = await convertGrokBotRecipe({
      recipe: parseGrokBotRecipe(recipeJson({ profile })),
      destination,
    });
    const read = await readClawManifestFile(destination);
    expect(read.ok, JSON.stringify(read.diagnostics)).toBe(true);
    if (!read.ok) {
      throw new Error("Expected a readable Claw");
    }
    expect(read.manifest.agent.identity?.avatar).toBe("assets/grok-bot-avatar.svg");
    expect(read.manifest.workspace.files).toContainEqual({
      source: "workspace/assets/grok-bot-avatar.svg",
      path: "assets/grok-bot-avatar.svg",
    });
    const svg = await readFile(join(destination, "workspace/assets/grok-bot-avatar.svg"), "utf8");
    expect(svg).toContain("#9159FE");
    expect(svg).toContain('fill="#A97EFE"');
    expect(svg).toContain('fill="#FFFFFF"');
    expect(svg).toContain("M47.43 203.54");
    expect(svg).not.toContain("href=");
    expect(result.warnings).toEqual([]);
    const fallback = await convertGrokBotRecipe({
      recipe: parseGrokBotRecipe(
        recipeJson({
          profile: {
            ...profile,
            avatarShape: "future-shape",
            avatarColor: 'red" onload="alert(1)',
          },
        }),
      ),
      destination: join(root, "unknown"),
    });
    expect(fallback.warnings.map((warning) => warning.code)).toContain("avatar_shape_unsupported");
    expect(fallback.warnings.map((warning) => warning.code)).toContain("avatar_color_unsupported");
    expect(fallback.completeness).toBe("complete");
    expect(
      await readFile(join(root, "unknown/workspace/assets/grok-bot-avatar.svg"), "utf8"),
    ).not.toContain("onload");
  });
});
