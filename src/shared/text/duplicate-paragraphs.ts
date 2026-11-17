import { expectDefined } from "@openclaw/normalization-core";
import {
  canReuseMarkdownOwnership,
  canReuseMarkdownOwnershipForAppend,
  findCodeOwnership,
  findCodeRegions,
} from "./code-regions.js";
import type { TextProjector } from "./text-projection-types.js";

function collapsePlainDuplicateParagraphs(text: string): string {
  return createDuplicateParagraphProjector(false)({ text, delta: null }).text;
}

export function collapseDuplicateParagraphs(
  text: string,
  protectedRegions?: ReturnType<typeof findCodeRegions>,
): string {
  const collapsed = collapsePlainDuplicateParagraphs(text);
  if (collapsed === text) {
    return text;
  }
  const regions = protectedRegions ?? findCodeRegions(text);
  if (regions.length === 0) {
    return collapsed;
  }
  // The marker is absent from source, so each indexed token is collision-free.
  let marker = "\0";
  while (text.includes(marker)) {
    marker += "\0";
  }
  const inlineTokens = new Map<string, string>();
  let masked = "";
  let cursor = 0;
  const protectedText = regions.map((region, index) => {
    const source = text.slice(region.start, region.end);
    let token = `${marker}${index}${marker}`;
    if (!region.block) {
      token = inlineTokens.get(source) ?? token;
      inlineTokens.set(source, token);
    }
    masked += text.slice(cursor, region.start) + token;
    cursor = region.end;
    return source;
  });
  // Only our indexed tokens contain the marker; a callback preserves literal dollar sequences.
  return collapsePlainDuplicateParagraphs(masked + text.slice(cursor)).replace(
    new RegExp(`${marker}(\\d+)${marker}`, "g"),
    (_token, index: string) => expectDefined(protectedText[Number(index)], "protected code text"),
  );
}

function normalizeDuplicateParagraph(text: string): string {
  let normalized = "";
  let cursor = 0;
  for (const region of text.includes("`") ? findCodeRegions(text) : []) {
    normalized += text.slice(cursor, region.start).replace(/\s+/g, " ");
    normalized += text.slice(region.start, region.end);
    cursor = region.end;
  }
  return normalized + text.slice(cursor).replace(/\s+/g, " ");
}

export function createDuplicateParagraphProjector(protectCode = true): TextProjector {
  let sourceTail = "";
  let activationTail = "";
  let separator: string | undefined;
  let text = "";
  let completed = "";
  let lastNormalized: string | null = null;
  let pendingEmpty = 0;
  let paragraph = "";
  let pending = "";
  let normalizedLength = 0;
  let equal = false;
  let newlines = 0;
  let hasDuplicate = false;
  let wasCollapsed = false;
  let wasDuplicate = false;
  let codeProtectionRequired = false;
  let nonlocalMarkersSeen = false;
  let backticksSeen = false;
  let codeProbeTail: string | undefined;
  let previousSource = "";
  let ownership: ReturnType<typeof findCodeOwnership> | undefined;
  return (input) => {
    let appended = input.delta ?? input.text;
    if (!separator) {
      const probe = activationTail + appended;
      const boundary = /\r?\n\r?\n/.exec(probe);
      // Retain a CRLF paragraph boundary split across appends.
      activationTail = probe.slice(-3);
      if (!boundary) {
        text = input.text;
        if (protectCode) {
          sourceTail = (sourceTail + appended).slice(-2048);
        }
        return input;
      }
      separator = boundary[0];
      appended = input.text;
    }
    let completedParagraph = false;
    let added = "";
    for (const part of appended.matchAll(/\n+|[^\n]+/g)) {
      if (part[0].startsWith("\n")) {
        if (newlines < 2 && newlines + part[0].length >= 2) {
          // One append can leave and re-enter duplicate state across this boundary.
          completedParagraph = true;
          const normalized = protectCode
            ? normalizeDuplicateParagraph(paragraph)
            : paragraph.replace(/\s+/g, " ");
          if (!paragraph) {
            if (lastNormalized !== null) {
              pendingEmpty++;
            }
          } else if (normalized === lastNormalized) {
            hasDuplicate = true;
          } else {
            completed += (completed ? separator : "") + paragraph;
            lastNormalized = normalized;
          }
          paragraph = "";
          pending = "";
          normalizedLength = 0;
          equal = Boolean(lastNormalized);
        } else if (newlines + part[0].length < 2 && paragraph) {
          pending += part[0];
        }
        newlines += part[0].length;
        continue;
      }
      // A CR between LF tokens can begin a split CRLF boundary.
      if (part[0] !== "\r") {
        newlines = 0;
      }
      const raw = paragraph ? part[0] : part[0].trimStart();
      const content = raw.trimEnd();
      if (!content) {
        pending += raw;
        continue;
      }
      const piece = pending + content;
      pending = raw.slice(content.length);
      if (!paragraph) {
        const empty = separator.repeat(pendingEmpty);
        if (pendingEmpty) {
          completed += empty;
          pendingEmpty = 0;
          lastNormalized = "";
          equal = false;
        }
        added += completed ? empty + separator : "";
      }
      const changesCode = protectCode && !canReuseMarkdownOwnershipForAppend(paragraph, piece);
      paragraph += piece;
      added += piece;
      if (changesCode) {
        const normalized = normalizeDuplicateParagraph(paragraph);
        equal = lastNormalized?.startsWith(normalized) === true;
        normalizedLength = normalized.length;
      } else if (equal) {
        const normalized = piece.replace(/\s+/g, " ");
        equal = lastNormalized?.startsWith(normalized, normalizedLength) === true;
        normalizedLength += normalized.length;
      }
    }
    let refreshOwnership = false;
    if (protectCode) {
      // Inline code is compared byte-for-byte; block and nonlocal Markdown
      // ownership still use the canonical whole-source correction path.
      const probe = codeProbeTail === undefined ? input.text : codeProbeTail + appended;
      nonlocalMarkersSeen ||= probe.includes("[") || probe.includes("]");
      backticksSeen ||= probe.includes("`");
      // A resolved link does not make every later continuation ownership-changing.
      if (
        nonlocalMarkersSeen &&
        backticksSeen &&
        (!ownership || !canReuseMarkdownOwnershipForAppend(previousSource, appended, ownership))
      ) {
        ownership = findCodeOwnership(input.text);
        refreshOwnership = true;
        // A link title closing can reclassify earlier code in this paragraph.
        const normalized = normalizeDuplicateParagraph(paragraph);
        equal = lastNormalized?.startsWith(normalized) === true;
        normalizedLength = normalized.length;
      }
      codeProtectionRequired ||=
        ownership?.unresolvedImageCodeStart !== undefined ||
        Boolean(ownership?.unsettledDefinitionStarts.length) ||
        /!\[|`{3,}/.test(probe) ||
        !canReuseMarkdownOwnership("", probe.replaceAll("`", ""));
      codeProbeTail = probe.slice(-3);
    }
    const duplicate = Boolean(paragraph) && equal && normalizedLength === lastNormalized?.length;
    const collapsed = hasDuplicate || duplicate;
    let delta = input.delta;
    if (refreshOwnership || (codeProtectionRequired && nonlocalMarkersSeen && backticksSeen)) {
      const projected = collapseDuplicateParagraphs(
        input.text,
        refreshOwnership ? ownership?.regions : undefined,
      );
      delta =
        input.delta !== null && projected.startsWith(text) ? projected.slice(text.length) : null;
      text = projected;
    } else if (collapsed) {
      // Code can expose pending whitespace; the plain suffix cannot safely append across it.
      delta =
        input.delta === null ||
        !wasCollapsed ||
        duplicate !== wasDuplicate ||
        completedParagraph ||
        (protectCode &&
          (/\s$/.test(text) || !canReuseMarkdownOwnership(sourceTail, sourceTail + appended)))
          ? null
          : added;
      text =
        delta === null
          ? codeProtectionRequired
            ? collapseDuplicateParagraphs(input.text)
            : completed + (paragraph && !duplicate ? (completed ? separator : "") + paragraph : "")
          : text + delta;
    } else {
      text = input.text;
      // A provisional duplicate can diverge, restoring every original separator, not just its own.
      if (wasCollapsed) {
        delta = null;
      }
    }
    wasCollapsed = collapsed;
    wasDuplicate = duplicate;
    previousSource = input.text;
    if (protectCode) {
      sourceTail = (sourceTail + (input.delta ?? input.text)).slice(-2048);
    }
    return { text, delta };
  };
}
