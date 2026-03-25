#!/usr/bin/env node

/**
 * Scans skills/{stage}/{skill}/SKILL.md and generates registry.json
 * Run: node scripts/generate-registry.js
 */

const fs = require("fs");
const path = require("path");

const SKILLS_DIR = path.join(__dirname, "..", "skills");
const OUTPUT = path.join(__dirname, "..", "registry.json");

const STAGES = {
  research: {
    label: "Research & Discovery",
    description: "Find and evaluate affiliate programs",
    order: 1,
  },
  content: {
    label: "Content Creation",
    description: "Create viral social media content",
    order: 2,
  },
  blog: { label: "Blog & SEO", description: "Long-form SEO-optimized articles", order: 3 },
  landing: { label: "Landing Pages", description: "High-converting affiliate pages", order: 4 },
  distribution: {
    label: "Distribution & Deployment",
    description: "Link hubs, bio pages, deployment",
    order: 5,
  },
  analytics: {
    label: "Analytics & Optimization",
    description: "Track, measure, and optimize affiliate performance",
    order: 6,
  },
  automation: {
    label: "Automation & Scale",
    description: "Automate workflows and scale what's working",
    order: 7,
  },
  meta: {
    label: "Meta",
    description: "Cross-cutting skills for discovery, planning, compliance, and self-improvement",
    order: 8,
  },
};

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  let currentKey = null;
  for (const line of match[1].split("\n")) {
    const kvMatch = line.match(/^(\w+):\s*(.+)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      fm[currentKey] = kvMatch[2].trim();
    } else if (currentKey && line.match(/^\s/)) {
      fm[currentKey] += " " + line.trim();
    }
  }
  return fm;
}

function parseOpenaiYaml(filepath) {
  if (!fs.existsSync(filepath)) return {};
  const content = fs.readFileSync(filepath, "utf-8");
  const result = {};
  const toolsMatch = content.match(/tools:\n((?:\s+-\s+.+\n?)+)/);
  if (toolsMatch) {
    result.tools = toolsMatch[1].match(/- (\S+)/g)?.map((t) => t.replace("- ", "")) || [];
  }
  return result;
}

function detectToolsFromBody(content) {
  const tools = new Set();
  const toolPatterns = [
    { pattern: /\bweb_search\b/, tool: "web_search" },
    { pattern: /\bweb_fetch\b/, tool: "web_fetch" },
    { pattern: /\bweb_browse\b/, tool: "web_browse" },
  ];
  for (const { pattern, tool } of toolPatterns) {
    if (pattern.test(content)) tools.add(tool);
  }
  return [...tools].sort();
}

function main() {
  const skills = [];

  const stageDirs = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && STAGES[d.name])
    .sort((a, b) => STAGES[a.name].order - STAGES[b.name].order);

  for (const stageDir of stageDirs) {
    const stagePath = path.join(SKILLS_DIR, stageDir.name);
    const skillDirs = fs
      .readdirSync(stagePath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const skillDir of skillDirs) {
      const skillMd = path.join(stagePath, skillDir.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;

      const content = fs.readFileSync(skillMd, "utf-8");
      const fm = parseFrontmatter(content);
      const openai = parseOpenaiYaml(path.join(stagePath, skillDir.name, "agents", "openai.yaml"));
      const bodyTools = detectToolsFromBody(content);
      // Merge: openai.yaml tools take precedence, body detection fills gaps
      const mergedTools = [...new Set([...(openai.tools || []), ...bodyTools])].sort();

      skills.push({
        name: fm.name || skillDir.name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        slug: skillDir.name,
        stage: stageDir.name,
        version: "1.0.0",
        description: fm.description || "",
        path: `skills/${stageDir.name}/${skillDir.name}`,
        agent_compatible: true,
        tools: mergedTools,
        author: "Affitor",
      });
    }
  }

  const registry = {
    version: "1.0.0",
    generated_at: new Date().toISOString(),
    stages: STAGES,
    skills,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(registry, null, 2) + "\n");
  console.log(
    `Generated registry.json with ${skills.length} skills across ${stageDirs.length} stages`,
  );
}

main();
