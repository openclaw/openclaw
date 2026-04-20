export type UnreleasedSection = "Breaking" | "Changes" | "Fixes";

function normalizePrRefToken(value: string): string {
  const match = value.match(/(?:^|\()#(\d+)(?:\)|$)|openclaw#(\d+)/i);
  const prNumber = match?.[1] ?? match?.[2];
  return prNumber ? `#${prNumber}` : value.trim().toLowerCase();
}

function stripBullet(line: string): string {
  return line.trim().replace(/^-\s+/, "");
}

function findPrReference(line: string): string | undefined {
  const match = line.match(/(?:\(#\d+\)|openclaw#\d+)/i);
  return match?.[0];
}

function entriesAreEquivalent(existingLine: string, newBullet: string): boolean {
  const existingBody = stripBullet(existingLine);
  const newBody = stripBullet(newBullet);
  if (existingBody === newBody) {
    return true;
  }

  const existingPrRef = findPrReference(existingBody);
  const newPrRef = findPrReference(newBody);
  if (!existingPrRef || !newPrRef) {
    return false;
  }

  if (normalizePrRefToken(existingPrRef) !== normalizePrRefToken(newPrRef)) {
    return false;
  }

  const existingWithoutRef = existingBody.replace(/(?:\s*\(#\d+\)|\s*openclaw#\d+)/gi, "").trim();
  const newWithoutRef = newBody.replace(/(?:\s*\(#\d+\)|\s*openclaw#\d+)/gi, "").trim();
  return existingWithoutRef === newWithoutRef;
}

function extractPrNumber(line: string): number | undefined {
  // 只取行里第一个 PR 引用作为排序键，避免 "(#123, #456)" 取到 456
  const match = line.match(/(?:\(#(\d+)\)|openclaw#(\d+))/i);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) {
    return undefined;
  }
  const num = Number.parseInt(raw, 10);
  return Number.isFinite(num) ? num : undefined;
}

function findSectionRange(
  lines: string[],
  section: UnreleasedSection,
): {
  start: number;
  bodyStart: number;
  bodyEnd: number;
} {
  const unreleasedIndex = lines.findIndex((line) => line.trim() === "## Unreleased");
  if (unreleasedIndex === -1) {
    throw new Error("CHANGELOG.md is missing the '## Unreleased' heading.");
  }

  const sectionHeading = `### ${section}`;
  let sectionIndex = -1;
  for (let index = unreleasedIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("## ")) {
      break;
    }
    if (line.trim() === sectionHeading) {
      sectionIndex = index;
      break;
    }
  }
  if (sectionIndex === -1) {
    throw new Error(`CHANGELOG.md is missing the '${sectionHeading}' section under Unreleased.`);
  }

  // bodyEnd 指向下一个 heading（### 或 ##），bodyStart 紧跟 section heading
  let bodyEnd = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("### ") || line.startsWith("## ")) {
      bodyEnd = index;
      break;
    }
  }
  while (bodyEnd > sectionIndex + 1 && lines[bodyEnd - 1]?.trim() === "") {
    bodyEnd -= 1;
  }

  return { start: sectionIndex, bodyStart: sectionIndex + 1, bodyEnd };
}

function resolveOrderedInsertIndex(
  lines: string[],
  bodyStart: number,
  bodyEnd: number,
  newPr: number | undefined,
): number {
  // 无 PR 号（手写条目等）fallback 到尾插，保持旧行为
  if (newPr === undefined) {
    return bodyEnd;
  }

  // 按 PR 号升序找第一个 PR 号大于 newPr 的已有条目，插到它前面
  // 没有 PR 号的历史行（极少见）当成边界，原地跳过
  for (let index = bodyStart; index < bodyEnd; index += 1) {
    const line = lines[index];
    if (!line.startsWith("- ")) {
      continue;
    }
    const existingPr = extractPrNumber(line);
    if (existingPr === undefined) {
      continue;
    }
    if (existingPr > newPr) {
      return index;
    }
  }
  return bodyEnd;
}

function findUnreleasedRange(lines: string[]): { start: number; end: number } | undefined {
  const unreleasedIndex = lines.findIndex((line) => line.trim() === "## Unreleased");
  if (unreleasedIndex === -1) {
    return undefined;
  }
  let end = lines.length;
  for (let index = unreleasedIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }
  return { start: unreleasedIndex, end };
}

function unreleasedHasPrEntry(lines: string[], prNumber: number): boolean {
  const range = findUnreleasedRange(lines);
  if (!range) {
    return false;
  }
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index];
    if (!line.startsWith("- ")) {
      continue;
    }
    if (extractPrNumber(line) === prNumber) {
      return true;
    }
  }
  return false;
}

export function appendUnreleasedChangelogEntry(
  content: string,
  params: {
    section: UnreleasedSection;
    entry: string;
  },
): string {
  const entry = params.entry.trim();
  if (!entry) {
    throw new Error("Changelog entry must not be empty.");
  }

  const lines = content.split("\n");
  const bullet = entry.startsWith("- ") ? entry : `- ${entry}`;

  // 强去重：同 PR 号在 ## Unreleased 下任意 subsection 已存在 → 跳过
  // 这避免了 merge 阶段二次 ensure 插入短版本，跟 prepare 阶段的详细条目重复
  const newPr = extractPrNumber(bullet);
  if (newPr !== undefined && unreleasedHasPrEntry(lines, newPr)) {
    return content;
  }

  // 文本级去重兜底（无 PR 号的手写条目 / 同行完全相等）
  if (lines.some((line) => entriesAreEquivalent(line, bullet))) {
    return content;
  }

  const { bodyStart, bodyEnd } = findSectionRange(lines, params.section);
  const insertAt = resolveOrderedInsertIndex(lines, bodyStart, bodyEnd, newPr);

  // 空 section：插到 heading 之后并补一个空行分隔
  if (bodyEnd === bodyStart) {
    lines.splice(insertAt, 0, bullet, "");
    return lines.join("\n");
  }

  // 非空 section：单独插一行，复用已有前后空行
  lines.splice(insertAt, 0, bullet);
  return lines.join("\n");
}
