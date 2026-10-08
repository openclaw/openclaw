// Advisory SKILL.md feedback for skill_workshop writes; never blocks a write.
import {
  parseFrontmatterBlock,
  stripFrontmatterBlock,
} from "../../../packages/markdown-core/src/frontmatter.js";

const MAX_DESCRIPTION_BYTES = 160;
const MAX_BODY_LINES = 250;
const MAX_BODY_BYTES = 12_000;
const MIN_NEGATION_LINES = 3;
const MAX_ADVISORIES = 3;

const NO_OP_WORDS =
  /\b(?:powerful|comprehensive|robust|seamless(?:ly)?|cutting-edge|state-of-the-art|be thorough|make sure to)\b/gi;
const SHOUTING = /\bIMPORTANT\b/g;
const NEGATION_LINE = /^(?:[-*+]|\d+[.)])?\s*(?:\*\*)?(?:never|don['’]t|do not)\b/i;
const NARRATIVE_LINE = /^(?:[-*+]\s*)?(?:\*\*)?(?:UPDATE|NOTE|EDIT)\b|\b20\d\d-\d\d-\d\d\b/;

type SkillLintFinding = { rule: string; message: string };

function readDescription(content: string): string {
  return (parseFrontmatterBlock(content).description ?? "").trim();
}

/** Authoring-convention findings for one SKILL.md, most useful first. */
function lintSkillMarkdown(content: string): SkillLintFinding[] {
  const description = readDescription(content);
  const body = stripFrontmatterBlock(content);
  // Code is quoted material; only prose carries authoring style.
  const prose = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .split("\n")
    .map((line) => line.trim());
  const descriptionBytes = Buffer.byteLength(description);
  const bodyLines = body.split("\n").length;
  const bodyBytes = Buffer.byteLength(body);
  const styled = [description, ...prose].join("\n");
  const noOps = [
    ...new Set([...(styled.match(NO_OP_WORDS) ?? []), ...(styled.match(SHOUTING) ?? [])]),
  ];
  const negations = prose.filter((line) => NEGATION_LINE.test(line)).length;
  const checks: Array<[rule: string, message: string | false]> = [
    [
      "description-length",
      descriptionBytes > MAX_DESCRIPTION_BYTES &&
        `description is ${descriptionBytes} bytes; trim it to ≤${MAX_DESCRIPTION_BYTES} with the trigger first.`,
    ],
    [
      "description-identity",
      /^(?:this|a|the) skill\b/i.test(description) &&
        'description opens with "This skill"; open with the situation that triggers it.',
    ],
    [
      "sprawl",
      (bodyLines > MAX_BODY_LINES || bodyBytes > MAX_BODY_BYTES) &&
        `SKILL.md body is ${bodyLines} lines (${bodyBytes} bytes); move reference only some runs need into references/ and point to it from its step.`,
    ],
    [
      "no-op",
      noOps.length > 0 &&
        `cut no-op emphasis (${noOps.slice(0, 3).join(", ")}); plain steps carry the same weight.`,
    ],
    [
      "negation",
      negations >= MIN_NEGATION_LINES &&
        `${negations} lines start with Never/Don't; state the behavior to produce instead.`,
    ],
    [
      "narrative",
      prose.some((line) => NARRATIVE_LINE.test(line)) &&
        "found an update note or date; fold the lesson into the step it changes.",
    ],
  ];
  return checks.flatMap(([rule, message]) => (message ? [{ rule, message }] : []));
}

/** Advisory lines for a successful SKILL.md write: lint rules this write introduced. */
export function skillWriteAdvisories(before: string, after: string): string[] {
  const standing = new Set(lintSkillMarkdown(before).map((finding) => finding.rule));
  return lintSkillMarkdown(after)
    .filter((finding) => !standing.has(finding.rule))
    .slice(0, MAX_ADVISORIES)
    .map((finding) => `Advisory (not blocking): ${finding.message} Fix with action=patch.`);
}
