#!/usr/bin/env node
/**
 * Batch update SKILL.md frontmatter for platform compliance:
 * 1. Add top-level `version: "1.0.0"` (semver, required by ClawHub)
 * 2. Add `tags` array (for ClawHub semantic search + skills.sh discovery)
 * 3. Add `compatibility` field (agentskills.io standard)
 * 4. Keep existing metadata.version for backward compat
 */

const fs = require("fs");
const path = require("path");

// Tags mapping by stage directory
const STAGE_TAGS = {
  research: ["affiliate-marketing", "research", "niche-analysis", "program-discovery"],
  content: ["affiliate-marketing", "content-creation", "social-media", "copywriting"],
  blog: ["affiliate-marketing", "blogging", "seo", "content-writing"],
  landing: ["affiliate-marketing", "landing-pages", "conversion", "offers"],
  distribution: ["affiliate-marketing", "distribution", "deployment", "email-marketing"],
  analytics: ["affiliate-marketing", "analytics", "optimization", "tracking"],
  automation: ["affiliate-marketing", "automation", "scaling", "workflow"],
  meta: ["affiliate-marketing", "meta", "planning", "compliance"],
};

// Skill-specific extra tags
const SKILL_EXTRA_TAGS = {
  "affiliate-program-search": ["saas", "commission"],
  "commission-calculator": ["commission", "revenue"],
  "competitor-spy": ["competitive-analysis"],
  "monopoly-niche-finder": ["monopoly", "blue-ocean"],
  "niche-opportunity-finder": ["niche", "opportunity"],
  "purple-cow-audit": ["differentiation", "positioning"],
  "content-pillar-atomizer": ["content-strategy", "repurposing"],
  "reddit-post-writer": ["reddit"],
  "tiktok-script-writer": ["tiktok", "video"],
  "twitter-thread-writer": ["twitter", "threads"],
  "viral-post-writer": ["viral", "social-media"],
  "affiliate-blog-builder": ["blog", "wordpress"],
  "comparison-post-writer": ["comparison", "versus"],
  "content-decay-detector": ["content-audit", "decay"],
  "content-moat-calculator": ["content-moat", "authority"],
  "how-to-tutorial-writer": ["tutorial", "how-to"],
  "keyword-cluster-architect": ["keywords", "clustering"],
  "listicle-generator": ["listicle", "top-lists"],
  "bonus-stack-builder": ["bonuses", "hormozi"],
  "grand-slam-offer": ["offers", "hormozi"],
  "guarantee-generator": ["guarantees", "risk-reversal"],
  "landing-page-creator": ["html", "tailwind"],
  "product-showcase-page": ["showcase", "product-page"],
  "squeeze-page-builder": ["lead-generation", "squeeze-page"],
  "value-ladder-architect": ["value-ladder", "pricing"],
  "webinar-registration-page": ["webinar", "registration"],
  "bio-link-deployer": ["bio-link", "linktree"],
  "email-drip-sequence": ["email", "drip-campaign"],
  "github-pages-deployer": ["github-pages", "static-site"],
  "social-media-scheduler": ["scheduling", "content-calendar"],
  "ab-test-generator": ["ab-testing", "experiments"],
  "conversion-tracker": ["conversion", "tracking"],
  "internal-linking-optimizer": ["internal-links", "site-structure"],
  "performance-report": ["reporting", "kpi"],
  "seo-audit": ["seo", "technical-seo"],
  "content-repurposer": ["repurposing", "multi-format"],
  "email-automation-builder": ["email", "automation"],
  "multi-program-manager": ["portfolio", "multi-program"],
  "paid-ad-copy-writer": ["ads", "ppc", "copywriting"],
  "proprietary-data-generator": ["data", "original-research"],
  "category-designer": ["category-design", "positioning"],
  "compliance-checker": ["ftc", "compliance", "disclosure"],
  "funnel-planner": ["funnel", "strategy"],
  "self-improver": ["improvement", "feedback"],
  "skill-finder": ["discovery", "skill-search"],
};

const COMPATIBILITY = "Claude Code, ChatGPT, Gemini CLI, Cursor, Windsurf, OpenClaw, any AI agent";

function processFile(filePath) {
  const content = fs.readFileSync(filePath, "utf-8");

  // Extract stage from path: skills/{stage}/{skill-name}/SKILL.md
  const parts = filePath.split(path.sep);
  const stageDir = parts[parts.indexOf("skills") + 1];
  const skillName = parts[parts.indexOf("skills") + 2];

  // Build tags
  const baseTags = STAGE_TAGS[stageDir] || ["affiliate-marketing"];
  const extraTags = SKILL_EXTRA_TAGS[skillName] || [];
  const allTags = [...new Set([...baseTags, ...extraTags])];

  // Find the `license: MIT` line and insert version + tags + compatibility after it
  const newFields = [
    `version: "1.0.0"`,
    `tags: [${allTags.map((t) => `"${t}"`).join(", ")}]`,
    `compatibility: "${COMPATIBILITY}"`,
  ].join("\n");

  // Replace: after "license: MIT\n", insert new fields
  const updated = content.replace(/^(license: MIT)\n(metadata:)/m, `$1\n${newFields}\n$2`);

  if (updated === content) {
    console.error(`  SKIP (no match): ${filePath}`);
    return false;
  }

  fs.writeFileSync(filePath, updated, "utf-8");
  console.log(`  OK: ${filePath} (${allTags.length} tags)`);
  return true;
}

// Process all skill files
const skillsDir = path.join(__dirname, "..", "skills");
let processed = 0;
let skipped = 0;

for (const stage of fs.readdirSync(skillsDir)) {
  const stageDir = path.join(skillsDir, stage);
  if (!fs.statSync(stageDir).isDirectory()) continue;

  for (const skill of fs.readdirSync(stageDir)) {
    const skillFile = path.join(stageDir, skill, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;

    if (processFile(skillFile)) {
      processed++;
    } else {
      skipped++;
    }
  }
}

// Also update template
const templateFile = path.join(__dirname, "..", "template", "SKILL.md");
if (fs.existsSync(templateFile)) {
  const content = fs.readFileSync(templateFile, "utf-8");
  const updated = content.replace(
    /^(license: MIT)\n(metadata:)/m,
    `$1\nversion: "1.0.0"\ntags: ["affiliate-marketing"]\ncompatibility: "${COMPATIBILITY}"\n$2`,
  );
  if (updated !== content) {
    fs.writeFileSync(templateFile, updated, "utf-8");
    console.log(`  OK: template/SKILL.md`);
    processed++;
  }
}

console.log(`\nDone: ${processed} updated, ${skipped} skipped`);
