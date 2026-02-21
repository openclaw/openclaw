/**
 * Constitutional Alignment System
 *
 * Defines and manages constitutional principles that guide the AI assistant's
 * behavior. Immutable principles are always-on and cannot be disabled.
 * Users can add custom principles and disable non-immutable ones.
 *
 * Addresses: T-IMPACT-003, attack chains 3 & 6
 */

import fs from "node:fs";
import type {
  SecurityAlignmentConfig,
  SecurityAlignmentPrinciple,
} from "../config/types.openclaw.js";
import defaultConstitutionData from "./constitution-default.json" with { type: "json" };

export type ConstitutionPrinciple = SecurityAlignmentPrinciple & {
  immutable: boolean;
};

export type Constitution = {
  version: number;
  principles: ConstitutionPrinciple[];
};

const CATEGORY_ORDER = ["honesty", "harmlessness", "safety", "helpfulness"];

/**
 * Load the constitution, merging defaults with user customizations.
 *
 * - Immutable principles cannot be disabled
 * - Custom principles are appended
 * - disabledPrinciples only affects non-immutable principles
 */
export function loadConstitution(config?: SecurityAlignmentConfig): Constitution {
  let basePrinciples: ConstitutionPrinciple[] = (
    defaultConstitutionData.principles as ConstitutionPrinciple[]
  ).map((p) => ({ ...p }));

  // Load custom constitution file if specified
  if (config?.constitutionPath) {
    try {
      const customData = JSON.parse(fs.readFileSync(config.constitutionPath, "utf-8"));
      if (Array.isArray(customData.principles)) {
        // Keep only immutable defaults; file principles replace the rest
        basePrinciples = basePrinciples.filter((p) => p.immutable);
        for (const p of customData.principles) {
          basePrinciples.push({
            ...p,
            immutable: false, // Never allow external files to set immutable
          });
        }
      }
    } catch (err) {
      console.error("Failed to load constitution file:", err);
    }
  }

  // Add custom principles from config
  if (config?.customPrinciples) {
    for (const custom of config.customPrinciples) {
      basePrinciples.push({
        ...custom,
        immutable: false,
      });
    }
  }

  // Remove disabled non-immutable principles
  const disabledSet = new Set(config?.disabledPrinciples ?? []);
  const activePrinciples = basePrinciples.filter((p) => {
    if (p.immutable) {
      return true; // Cannot disable immutable principles
    }
    return !disabledSet.has(p.id);
  });

  return {
    version: defaultConstitutionData.version,
    principles: activePrinciples,
  };
}

/**
 * Get only immutable principles (for hardcoded safety section fallback).
 */
export function getImmutablePrinciples(constitution: Constitution): ConstitutionPrinciple[] {
  return constitution.principles.filter((p) => p.immutable);
}

/**
 * Format constitution principles as markdown for system prompt injection.
 */
export function formatConstitutionForPrompt(constitution: Constitution): string {
  const lines: string[] = ["## Safety & Alignment Principles"];

  // Group by category
  const byCategory = new Map<string, ConstitutionPrinciple[]>();
  for (const p of constitution.principles) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  // Output in category order
  const orderedCategories = [
    ...CATEGORY_ORDER.filter((c) => byCategory.has(c)),
    ...Array.from(byCategory.keys()).filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  for (const category of orderedCategories) {
    const principles = byCategory.get(category);
    if (!principles || principles.length === 0) {
      continue;
    }
    const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`### ${categoryLabel}`);
    for (const p of principles) {
      lines.push(`- **${p.label}**: ${p.principle}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format only immutable principles for the hardcoded safety section.
 * Used as fallback when alignment plugin is not loaded.
 */
export function formatImmutableSafetySection(constitution?: Constitution): string[] {
  const c = constitution ?? loadConstitution();
  const immutable = getImmutablePrinciples(c);

  if (immutable.length === 0) {
    return [
      "## Safety",
      "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
      "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
      "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
      "",
    ];
  }

  const lines: string[] = ["## Safety"];
  for (const p of immutable) {
    lines.push(`- ${p.principle}`);
  }
  lines.push("");
  return lines;
}
