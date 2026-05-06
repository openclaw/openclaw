import JSON5 from "json5";

export type OcPathDocumentKind = "json" | "markdown";

export type ParsedOcPath = {
  filePath: string;
  segments: string[];
};

export type OcPathResolvedNode =
  | {
      kind: "value";
      path: string;
      value: unknown;
    }
  | {
      kind: "markdown-section";
      path: string;
      heading: string;
      line: number;
      valueText: string;
    };

type MarkdownSection = {
  title: string;
  depth: number;
  line: number;
  bodyStartOffset: number;
  endOffset: number;
  children: MarkdownSection[];
};

const JSON_EXTENSIONS = [".json", ".jsonc", ".json5"] as const;
const MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;
const SUPPORTED_EXTENSIONS = [...JSON_EXTENSIONS, ...MARKDOWN_EXTENSIONS] as const;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function buildResolvedPath(filePath: string, segments: readonly string[]): string {
  return `oc://${filePath}${segments.length > 0 ? `/${segments.join("/")}` : ""}`;
}

function findFilePathEnd(target: string): number {
  let best = -1;
  for (const extension of SUPPORTED_EXTENSIONS) {
    let from = 0;
    while (from < target.length) {
      const index = target.indexOf(`${extension}/`, from);
      if (index === -1) {
        break;
      }
      best = Math.max(best, index + extension.length);
      from = index + extension.length + 1;
    }
    if (target.endsWith(extension)) {
      best = Math.max(best, target.length);
    }
  }
  return best;
}

export function parseOcPath(input: string): ParsedOcPath {
  if (!input.startsWith("oc://")) {
    throw new Error("OpenClaw path must start with oc://");
  }
  const target = input.slice("oc://".length);
  const filePathEnd = findFilePathEnd(target);
  if (filePathEnd <= 0) {
    throw new Error("OpenClaw path must include a supported workspace file");
  }
  const filePath = decodeSegment(target.slice(0, filePathEnd));
  const rest = target.slice(filePathEnd);
  const segments = rest.startsWith("/")
    ? rest
        .slice(1)
        .split("/")
        .filter((segment) => segment.length > 0)
        .map(decodeSegment)
    : [];
  return { filePath, segments };
}

export function getOcPathDocumentKind(filePath: string): OcPathDocumentKind {
  const lower = filePath.toLowerCase();
  if (JSON_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return "json";
  }
  if (MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return "markdown";
  }
  throw new Error(`Unsupported OpenClaw path file kind: ${filePath}`);
}

function parseJsonDocument(content: string): unknown {
  return JSON5.parse(content);
}

function normalizeArrayIndex(segment: string, length: number): number | undefined {
  if (!/^-?\d+$/.test(segment)) {
    return undefined;
  }
  const parsed = Number(segment);
  const index = parsed < 0 ? length + parsed : parsed;
  return index >= 0 && index < length ? index : undefined;
}

function parsePredicate(segment: string): { key: string; value: string } | undefined {
  const match = /^\[([^=\]]+)=([^\]]*)\]$/.exec(segment);
  if (!match) {
    return undefined;
  }
  return { key: match[1], value: match[2] };
}

function resolveJsonSegment(value: unknown, segment: string): unknown {
  if (Array.isArray(value)) {
    const index = normalizeArrayIndex(segment, value.length);
    if (index !== undefined) {
      return value[index];
    }
    const predicate = parsePredicate(segment);
    if (predicate) {
      return value.find((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return false;
        }
        return String((entry as Record<string, unknown>)[predicate.key]) === predicate.value;
      });
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    return (value as Record<string, unknown>)[segment];
  }
  return undefined;
}

function resolveJsonPath(params: {
  filePath: string;
  content: string;
  segments: string[];
}): OcPathResolvedNode | undefined {
  let value = parseJsonDocument(params.content);
  for (const segment of params.segments) {
    value = resolveJsonSegment(value, segment);
    if (value === undefined) {
      return undefined;
    }
  }
  return {
    kind: "value",
    path: buildResolvedPath(params.filePath, params.segments),
    value,
  };
}

function findJsonPathMatches(params: {
  filePath: string;
  content: string;
  segments: string[];
}): OcPathResolvedNode[] {
  const root = parseJsonDocument(params.content);
  const matches: Array<{ value: unknown; segments: string[] }> = [{ value: root, segments: [] }];
  for (const segment of params.segments) {
    const next: Array<{ value: unknown; segments: string[] }> = [];
    for (const match of matches) {
      if (segment === "*") {
        if (Array.isArray(match.value)) {
          match.value.forEach((value, index) =>
            next.push({ value, segments: [...match.segments, String(index)] }),
          );
        } else if (match.value && typeof match.value === "object") {
          for (const [key, value] of Object.entries(match.value)) {
            next.push({ value, segments: [...match.segments, key] });
          }
        }
        continue;
      }
      const value = resolveJsonSegment(match.value, segment);
      if (value !== undefined) {
        next.push({ value, segments: [...match.segments, segment] });
      }
    }
    matches.splice(0, matches.length, ...next);
  }
  return matches.map((match) => ({
    kind: "value",
    path: buildResolvedPath(params.filePath, match.segments),
    value: match.value,
  }));
}

function parseMarkdownSections(content: string): MarkdownSection[] {
  const root: MarkdownSection = {
    title: "",
    depth: 0,
    line: 0,
    bodyStartOffset: 0,
    endOffset: content.length,
    children: [],
  };
  const stack: MarkdownSection[] = [root];
  const headingPattern = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(content))) {
    const depth = match[1].length;
    const line = content.slice(0, match.index).split("\n").length;
    const section: MarkdownSection = {
      title: match[2].trim(),
      depth,
      line,
      bodyStartOffset: headingPattern.lastIndex,
      endOffset: content.length,
      children: [],
    };
    while (stack[stack.length - 1].depth >= depth) {
      const closed = stack.pop();
      if (closed) {
        closed.endOffset = match.index;
      }
    }
    stack[stack.length - 1].children.push(section);
    stack.push(section);
  }
  return root.children;
}

function findMarkdownChild(
  sections: readonly MarkdownSection[],
  segment: string,
): MarkdownSection | undefined {
  return sections.find((section) => section.title === segment);
}

function findMarkdownDescendants(
  sections: readonly MarkdownSection[],
  segment: string,
): MarkdownSection[] {
  const matches: MarkdownSection[] = [];
  for (const section of sections) {
    if (section.title === segment) {
      matches.push(section);
    }
    matches.push(...findMarkdownDescendants(section.children, segment));
  }
  return matches;
}

function toMarkdownResolvedNode(params: {
  filePath: string;
  content: string;
  segments: string[];
  section: MarkdownSection;
}): OcPathResolvedNode {
  return {
    kind: "markdown-section",
    path: buildResolvedPath(params.filePath, params.segments),
    heading: params.section.title,
    line: params.section.line,
    valueText: params.content
      .slice(params.section.bodyStartOffset, params.section.endOffset)
      .trim(),
  };
}

function resolveMarkdownPath(params: {
  filePath: string;
  content: string;
  segments: string[];
}): OcPathResolvedNode | undefined {
  const roots = parseMarkdownSections(params.content);
  let children = roots;
  let section: MarkdownSection | undefined;
  for (const [index, segment] of params.segments.entries()) {
    section =
      index === 0
        ? (findMarkdownChild(children, segment) ?? findMarkdownDescendants(roots, segment)[0])
        : findMarkdownChild(children, segment);
    if (!section) {
      return undefined;
    }
    children = section.children;
  }
  return section
    ? toMarkdownResolvedNode({ ...params, section })
    : {
        kind: "markdown-section",
        path: buildResolvedPath(params.filePath, []),
        heading: "",
        line: 1,
        valueText: params.content.trim(),
      };
}

function findMarkdownPathMatches(params: {
  filePath: string;
  content: string;
  segments: string[];
}): OcPathResolvedNode[] {
  const roots = parseMarkdownSections(params.content);
  let matches: Array<{ section: MarkdownSection; segments: string[] }> = roots.map((section) => ({
    section,
    segments: [section.title],
  }));
  if (params.segments.length === 0) {
    return [
      {
        kind: "markdown-section",
        path: buildResolvedPath(params.filePath, []),
        heading: "",
        line: 1,
        valueText: params.content.trim(),
      },
    ];
  }
  for (const [index, segment] of params.segments.entries()) {
    const source =
      index === 0
        ? (segment === "*" ? roots : findMarkdownDescendants(roots, segment)).map((section) => ({
            section,
            segments: [section.title],
          }))
        : matches.flatMap((match) =>
            match.section.children.map((section) => ({
              section,
              segments: [...match.segments, section.title],
            })),
          );
    matches =
      index === 0 && segment !== "*"
        ? source
        : source.filter((match) => segment === "*" || match.section.title === segment);
  }
  return matches.map((match) =>
    toMarkdownResolvedNode({
      filePath: params.filePath,
      content: params.content,
      segments: match.segments,
      section: match.section,
    }),
  );
}

export function resolveOcPath(params: {
  ocPath: string;
  content: string;
}): OcPathResolvedNode | undefined {
  const parsed = parseOcPath(params.ocPath);
  const kind = getOcPathDocumentKind(parsed.filePath);
  if (kind === "json") {
    return resolveJsonPath({ ...parsed, content: params.content });
  }
  return resolveMarkdownPath({ ...parsed, content: params.content });
}

export function findOcPaths(params: { ocPath: string; content: string }): OcPathResolvedNode[] {
  const parsed = parseOcPath(params.ocPath);
  const kind = getOcPathDocumentKind(parsed.filePath);
  if (kind === "json") {
    return findJsonPathMatches({ ...parsed, content: params.content });
  }
  return findMarkdownPathMatches({ ...parsed, content: params.content });
}
