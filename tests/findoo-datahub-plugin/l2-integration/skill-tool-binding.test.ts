/**
 * L2 Integration: Skill-tool binding verification
 *
 * Tests that all 33 skill packs correctly reference tools that are
 * actually registered by the plugin, and that metadata is consistent.
 *
 * Uses real filesystem reads (skill.md files) + plugin registration analysis.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* ---------- constants ---------- */

const PLUGIN_ROOT = join(import.meta.dirname, "../../../extensions/findoo-datahub-plugin");
const SKILLS_DIR = join(PLUGIN_ROOT, "skills");
const PLUGIN_ID = "findoo-datahub-plugin";

/**
 * All tools registered by findoo-datahub-plugin.
 * Sourced from index.ts (13 tools) and register-tools.ts (12 tools).
 * The plugin registers tools in both files; register-tools.ts is the newer version.
 * We list the union of all tool names that the plugin can register.
 */
const REGISTERED_TOOLS = new Set([
  "fin_stock",
  "fin_index",
  "fin_macro",
  "fin_derivatives",
  "fin_crypto",
  "fin_market",
  "fin_query",
  "fin_data_ohlcv",
  "fin_data_regime",
  "fin_ta",
  "fin_etf",
  "fin_currency",
  "fin_data_markets",
]);

/* ---------- helpers ---------- */

interface SkillMetadata {
  name: string;
  description: string;
  dirName: string;
  toolsReferenced: string[];
  requiresExtensions: string[];
  rawContent: string;
}

function parseSkillMd(dirName: string, content: string): SkillMetadata {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = frontmatterMatch?.[1] ?? "";

  // Extract name from frontmatter
  const nameMatch = frontmatter.match(/^name:\s*(.+)/m);
  const name = nameMatch?.[1]?.trim().replace(/^["']|["']$/g, "") ?? dirName;

  // Extract description
  const descMatch = frontmatter.match(/^description:\s*"([^"]+)"/m);
  const description = descMatch?.[1] ?? "";

  // Extract requires.extensions from YAML-like metadata
  const extensionsMatch = content.match(/"extensions":\s*\[([^\]]*)\]/);
  const requiresExtensions: string[] = [];
  if (extensionsMatch?.[1]) {
    const exts = extensionsMatch[1].match(/"([^"]+)"/g);
    if (exts) {
      for (const ext of exts) {
        requiresExtensions.push(ext.replace(/"/g, ""));
      }
    }
  }

  // Extract tool references from body (fin_* patterns)
  const toolPattern = /\bfin_\w+\b/g;
  const toolsReferenced = [...new Set(content.match(toolPattern) ?? [])];

  return { name, description, dirName, toolsReferenced, requiresExtensions, rawContent: content };
}

function loadAllSkills(): SkillMetadata[] {
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills: SkillMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = join(SKILLS_DIR, entry.name, "skill.md");
    try {
      const content = readFileSync(skillPath, "utf-8");
      skills.push(parseSkillMd(entry.name, content));
    } catch {
      // Skip directories without skill.md
    }
  }

  return skills;
}

/* ---------- tests ---------- */

const skills = loadAllSkills();

describe("Skill catalog completeness", () => {
  it("has at least 30 skills loaded", () => {
    expect(skills.length).toBeGreaterThanOrEqual(30);
  });

  it("README documents exactly 33 skills", () => {
    const readme = readFileSync(join(SKILLS_DIR, "README.md"), "utf-8");
    const totalMatch = readme.match(/\*\*Total\*\*\s*\|\s*\*\*(\d+)\*\*/);
    expect(totalMatch).not.toBeNull();
    expect(Number(totalMatch![1])).toBe(33);
  });
});

describe("Skill requires.extensions matches plugin ID", () => {
  for (const skill of skills) {
    it(`${skill.name} references extension "${PLUGIN_ID}"`, () => {
      expect(skill.requiresExtensions).toContain(PLUGIN_ID);
    });
  }
});

describe("Skill-referenced tools are all registered by plugin", () => {
  for (const skill of skills) {
    it(`${skill.name}: all referenced tools exist in plugin registry`, () => {
      const unknownTools = skill.toolsReferenced.filter((t) => !REGISTERED_TOOLS.has(t));
      expect(
        unknownTools,
        `Skill "${skill.name}" references unregistered tools: ${unknownTools.join(", ")}`,
      ).toEqual([]);
    });
  }
});

describe("Every registered tool is referenced by at least one skill", () => {
  it("all 13 tools have skill coverage", () => {
    const allReferencedTools = new Set(skills.flatMap((s) => s.toolsReferenced));

    for (const tool of REGISTERED_TOOLS) {
      expect(
        allReferencedTools.has(tool),
        `Tool "${tool}" is registered but not referenced by any skill`,
      ).toBe(true);
    }
  });
});

describe("Skill frontmatter integrity", () => {
  for (const skill of skills) {
    it(`${skill.name} has valid name`, () => {
      expect(skill.name).toBeTruthy();
      // Should start with "fin-"
      expect(skill.name).toMatch(/^fin-/);
    });

    it(`${skill.name} has non-empty description`, () => {
      expect(skill.description.length).toBeGreaterThan(20);
    });

    it(`${skill.name} has frontmatter delimiters`, () => {
      expect(skill.rawContent).toMatch(/^---\n/);
      expect(skill.rawContent).toMatch(/\n---\n/);
    });
  }
});

describe("Skill routing metadata", () => {
  it("no duplicate skill names", () => {
    const names = skills.map((s) => s.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it("each skill has emoji metadata", () => {
    for (const skill of skills) {
      const hasEmoji = skill.rawContent.includes('"emoji"');
      expect(hasEmoji, `Skill "${skill.name}" missing emoji metadata`).toBe(true);
    }
  });

  it("skill descriptions contain Use when / NOT for routing hints", () => {
    // At least most skills should have routing hints
    const withRouting = skills.filter(
      (s) =>
        s.description.toLowerCase().includes("use when") ||
        s.description.toLowerCase().includes("not for"),
    );
    // Allow a few skills to lack explicit routing (e.g., data-query)
    expect(withRouting.length).toBeGreaterThanOrEqual(skills.length * 0.8);
  });
});

describe("Tool parameter schema consistency with skills", () => {
  it("most skills referencing fin_stock mention symbol format guidance", () => {
    const stockSkills = skills.filter((s) => s.toolsReferenced.includes("fin_stock"));
    expect(stockSkills.length).toBeGreaterThan(0);

    // Cross-market/utility skills (factor-screen, etf-fund, etc.) may not mention specific symbols
    const withFormat = stockSkills.filter((skill) => {
      return (
        skill.rawContent.includes(".SH") ||
        skill.rawContent.includes(".SZ") ||
        skill.rawContent.includes(".HK") ||
        skill.rawContent.includes("AAPL") ||
        skill.rawContent.includes("stock code") ||
        skill.rawContent.includes("symbol")
      );
    });

    // At least 70% of fin_stock skills should have symbol guidance
    expect(withFormat.length).toBeGreaterThanOrEqual(Math.floor(stockSkills.length * 0.7));
  });

  it("skills referencing fin_crypto mention crypto-specific params", () => {
    const cryptoSkills = skills.filter((s) => s.toolsReferenced.includes("fin_crypto"));
    expect(cryptoSkills.length).toBeGreaterThan(0);

    for (const skill of cryptoSkills) {
      // Should mention endpoints or crypto concepts
      const hasCryptoContext =
        skill.rawContent.includes("endpoint") ||
        skill.rawContent.includes("coin") ||
        skill.rawContent.includes("defi") ||
        skill.rawContent.includes("ticker");
      expect(
        hasCryptoContext,
        `Skill "${skill.name}" uses fin_crypto but lacks crypto context`,
      ).toBe(true);
    }
  });

  it("skills referencing fin_macro mention macro endpoints or indicators", () => {
    const macroSkills = skills.filter((s) => s.toolsReferenced.includes("fin_macro"));
    expect(macroSkills.length).toBeGreaterThan(0);

    for (const skill of macroSkills) {
      const hasMacroContext =
        skill.rawContent.toLowerCase().includes("gdp") ||
        skill.rawContent.toLowerCase().includes("cpi") ||
        skill.rawContent.toLowerCase().includes("shibor") ||
        skill.rawContent.toLowerCase().includes("rate") ||
        skill.rawContent.toLowerCase().includes("treasury") ||
        skill.rawContent.toLowerCase().includes("macro");
      expect(hasMacroContext, `Skill "${skill.name}" uses fin_macro but lacks macro context`).toBe(
        true,
      );
    }
  });
});

describe("Market coverage by skills", () => {
  it("A-share market has >= 8 dedicated skills", () => {
    const aShareSkills = skills.filter(
      (s) => s.name.startsWith("fin-a-") || s.description.toLowerCase().includes("a-share"),
    );
    expect(aShareSkills.length).toBeGreaterThanOrEqual(8);
  });

  it("HK market has >= 4 dedicated skills", () => {
    const hkSkills = skills.filter(
      (s) => s.name.startsWith("fin-hk-") || s.description.toLowerCase().includes("hk stock"),
    );
    expect(hkSkills.length).toBeGreaterThanOrEqual(4);
  });

  it("US market has >= 4 dedicated skills", () => {
    const usSkills = skills.filter(
      (s) => s.name.startsWith("fin-us-") || s.description.toLowerCase().includes("us stock"),
    );
    expect(usSkills.length).toBeGreaterThanOrEqual(4);
  });

  it("Crypto market has >= 5 dedicated skills", () => {
    const cryptoSkills = skills.filter(
      (s) =>
        s.name.startsWith("fin-crypto") ||
        (s.description.toLowerCase().includes("crypto") && s.name.includes("crypto")),
    );
    expect(cryptoSkills.length).toBeGreaterThanOrEqual(5);
  });

  it("cross-market skills exist (macro, derivatives, cross-asset)", () => {
    const crossMarket = skills.filter(
      (s) =>
        s.name === "fin-macro" ||
        s.name === "fin-derivatives" ||
        s.name === "fin-cross-asset" ||
        s.name === "fin-risk-monitor",
    );
    expect(crossMarket.length).toBeGreaterThanOrEqual(3);
  });
});
