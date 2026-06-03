import { formatErrorMessage } from "../../infra/errors.js";
import type { SkillEntry } from "../types.js";
import { decodeMetaFrontmatter } from "./frontmatter.js";
import { parseMetaPlan } from "./parser.js";
import type { MetaDiagnostic, MetaPlan } from "./types.js";

export type MetaSkillCatalog = {
  plans: MetaPlan[];
  diagnostics: MetaDiagnostic[];
};

export function buildMetaSkillCatalog(
  entries: readonly SkillEntry[] | undefined,
): MetaSkillCatalog {
  const plans: MetaPlan[] = [];
  const diagnostics: MetaDiagnostic[] = [];

  for (const entry of entries ?? []) {
    if (entry.frontmatter.kind !== "meta") {
      continue;
    }

    try {
      plans.push(parseMetaPlan(decodeMetaFrontmatter(entry.frontmatter), entry.skill.filePath));
    } catch (error) {
      diagnostics.push({
        skillName: entry.skill.name,
        filePath: entry.skill.filePath,
        message: formatErrorMessage(error),
      });
    }
  }

  return {
    plans: plans.toSorted((left, right) => left.name.localeCompare(right.name, "en")),
    diagnostics: diagnostics.toSorted((left, right) =>
      left.skillName.localeCompare(right.skillName, "en"),
    ),
  };
}

export function findMetaPlanByName(catalog: MetaSkillCatalog, name: string): MetaPlan | undefined {
  return catalog.plans.find((plan) => plan.name === name);
}
