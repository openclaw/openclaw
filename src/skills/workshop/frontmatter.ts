import { parseFrontmatter } from "../loading/frontmatter.js";

type ProposalFrontmatter = {
  name: string;
  description: string;
};

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

export function renderProposalMarkdown(params: {
  name: string;
  description: string;
  content: string;
  version?: string;
  date?: string;
}): string {
  const body = stripFrontmatterBlock(params.content).trimStart();
  const version = params.version ?? "v1";
  const date = params.date ?? new Date().toISOString();
  return `---\nname: ${yamlScalar(params.name)}\ndescription: ${yamlScalar(params.description)}\nstatus: proposal\nversion: ${yamlScalar(version)}\ndate: ${yamlScalar(date)}\n---\n\n${body}`;
}

export function readProposalFrontmatter(content: string): ProposalFrontmatter | null {
  const frontmatter = parseFrontmatter(content);
  const name = frontmatter.name?.trim();
  const description = frontmatter.description?.trim();
  const status = frontmatter.status?.trim().toLowerCase();
  if (!name || !description || status !== "proposal") {
    return null;
  }
  return { name, description };
}

export function stripProposalFrontmatterForSkill(content: string): string {
  const normalized = normalizeNewlines(content);
  if (!normalized.startsWith("---")) {
    return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  }

  const rawBlock = normalized.slice(4, endIndex);
  const bodyStart = endIndex + "\n---".length;
  const body = normalized.slice(bodyStart).replace(/^\n+/, "");
  const keptLines = rawBlock
    .split("\n")
    .filter((line) => {
      const key = line.match(/^([\w-]+):/)?.[1]?.toLowerCase();
      return key !== "status" && key !== "version" && key !== "date";
    })
    .join("\n")
    .trim();

  const result = keptLines ? `---\n${keptLines}\n---\n\n${body}` : body;
  return result.endsWith("\n") ? result : `${result}\n`;
}

function stripFrontmatterBlock(content: string): string {
  const normalized = normalizeNewlines(content);
  if (!normalized.startsWith("---")) {
    return normalized;
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return normalized;
  }
  return normalized.slice(endIndex + "\n---".length).replace(/^\n+/, "");
}

function normalizeNewlines(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}
