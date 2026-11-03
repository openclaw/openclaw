import { isSensitiveUrlQueryParamName } from "@openclaw/net-policy/redact-sensitive-url";
import type { RedactionEdit } from "./redact-edit-composition.js";
import { maskToken, splitSecretValueForMask } from "./redact-mask.js";
import { FORM_BODY_KEY_INVISIBLE_CHARS } from "./redact-patterns.js";

const FORM_BODY_KEY_OBFUSCATION_RE = new RegExp(
  String.raw`[${FORM_BODY_KEY_INVISIBLE_CHARS}+]`,
  "gu",
);
const FORM_BODY_KEY_SEPARATOR_RE = /[\p{C}\p{Z}\u115F\u1160\u3164\uFFA0+]/gu;
const FORM_BODY_PERCENT_ESCAPE_RE = /%[0-9A-Fa-f]{2}/u;
const FORM_BODY_KEY = String.raw`[${FORM_BODY_KEY_INVISIBLE_CHARS}+]*(?:[A-Za-z_]|%[0-9A-Fa-f]{2})(?:[A-Za-z0-9_.-]|%[0-9A-Fa-f]{2}|[${FORM_BODY_KEY_INVISIBLE_CHARS}+])*`;
const FORM_BODY_VALUE = "[^&\\s<>]*";
const URL_QUERY_VALUE = "[^&#\\s<>]*";
const FORM_BODY_PAIR = String.raw`${FORM_BODY_KEY}=${FORM_BODY_VALUE}`;
const FORM_BODY_RE = new RegExp(String.raw`^${FORM_BODY_PAIR}(?:&${FORM_BODY_PAIR})+$`, "u");
const FORM_BODY_SUBSTRING_RE = new RegExp(
  String.raw`(^|[\s:({\[,="'` + "`" + String.raw`])(${FORM_BODY_PAIR}(?:&${FORM_BODY_PAIR})+)`,
  "gu",
);
const ENCODED_FORM_PAIR_RE = new RegExp(
  String.raw`(^|[\s:({\[,="'` + "`" + String.raw`&])(${FORM_BODY_KEY})=(${FORM_BODY_VALUE})`,
  "gu",
);
const FORM_BODY_CONTEXT_SINGLE_PAIR_RE = new RegExp(
  String.raw`(\b(?:body|form(?:[-_\s]?body)?)\s*[:=]\s*(["'\x60]?))(${FORM_BODY_KEY})=(${FORM_BODY_VALUE})(["'\x60]?)`,
  "giu",
);
const URL_QUERY_PAIR_RE = new RegExp(
  String.raw`([?&])(${FORM_BODY_KEY})=(${URL_QUERY_VALUE})`,
  "gu",
);
const FORM_BODY_LINE_BREAK_SPLIT_RE = /(\r\n|\r|\n)/u;
const FORM_BODY_LINE_BREAK_SEGMENT_RE = /^(?:\r\n|\r|\n)$/u;

export type PreparationEditSink = (edits: RedactionEdit[]) => void;

export function createFormBodyRedactor(bodySecretKeys: ReadonlySet<string>) {
  function normalizeSensitiveKeyName(value: string): string {
    const stripped = value.replace(FORM_BODY_KEY_SEPARATOR_RE, "");
    try {
      return decodeURIComponent(stripped)
        .replace(FORM_BODY_KEY_SEPARATOR_RE, "")
        .toLowerCase()
        .replaceAll("-", "_");
    } catch {
      return stripped.toLowerCase().replaceAll("-", "_");
    }
  }

  function isSensitiveBodyKey(key: string): boolean {
    return isSensitiveUrlQueryParamName(key) || bodySecretKeys.has(normalizeSensitiveKeyName(key));
  }

  function hasEncodedOrInvisibleFormKey(key: string): boolean {
    return (
      FORM_BODY_PERCENT_ESCAPE_RE.test(key) || key.replace(FORM_BODY_KEY_OBFUSCATION_RE, "") !== key
    );
  }

  type SensitiveAssignmentKind = "form" | "url" | "encoded" | "context";

  // Visit one grammar pass in source order. The sinks keep replacement and original-offset
  // coverage separate; later text passes still detect assignments in the rewritten text.
  function visitSensitiveAssignments(
    text: string,
    kind: SensitiveAssignmentKind,
    visit: (start: number, end: number, maskable: string) => void,
  ): void {
    if (!text || (kind === "url" && !text.includes("?"))) {
      return;
    }
    if (
      kind === "encoded" &&
      !text.includes("%") &&
      text.replace(FORM_BODY_KEY_OBFUSCATION_RE, "") === text
    ) {
      return;
    }
    if (kind === "context" && !/[=:]/u.test(text)) {
      return;
    }
    const visitPair = (key: string, token: string, valueOffset: number): void => {
      if (kind === "encoded" && !hasEncodedOrInvisibleFormKey(key)) {
        return;
      }
      if (!isSensitiveBodyKey(key)) {
        return;
      }
      const { maskable, maskStart, maskEnd } = splitSecretValueForMask(token);
      visit(valueOffset + maskStart, valueOffset + maskEnd, maskable);
    };
    if (kind === "form") {
      let cursor = 0;
      for (const pair of text.split("&")) {
        const equalsIndex = pair.indexOf("=");
        if (equalsIndex >= 0) {
          visitPair(
            pair.slice(0, equalsIndex),
            pair.slice(equalsIndex + 1),
            cursor + equalsIndex + 1,
          );
        }
        cursor += pair.length + 1;
      }
      return;
    }
    const pattern =
      kind === "url"
        ? URL_QUERY_PAIR_RE
        : kind === "encoded"
          ? ENCODED_FORM_PAIR_RE
          : FORM_BODY_CONTEXT_SINGLE_PAIR_RE;
    const keyIndex = kind === "context" ? 3 : 2;
    // These private synchronous sinks cannot re-enter the scanner. Release regex state on errors too.
    pattern.lastIndex = 0;
    try {
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const prefix = match[1] ?? "";
        const key = match[keyIndex] ?? "";
        visitPair(key, match[keyIndex + 1] ?? "", match.index + prefix.length + key.length + 1);
      }
    } finally {
      pattern.lastIndex = 0;
    }
  }

  function redactAssignmentValues(
    text: string,
    kind: SensitiveAssignmentKind,
    onEdits?: PreparationEditSink,
  ): string {
    const parts: string[] = [];
    const edits: RedactionEdit[] = [];
    let cursor = 0;
    visitSensitiveAssignments(text, kind, (start, end, maskable) => {
      const replacement = kind === "url" ? maskToken(maskable) : "***";
      parts.push(text.slice(cursor, start), replacement);
      if (onEdits) {
        edits.push({ start, end, replacement });
      }
      cursor = end;
    });
    if (edits.length > 0) {
      onEdits?.(edits);
    }
    return parts.length > 0 ? parts.join("") + text.slice(cursor) : text;
  }

  function redactFormBodyLine(text: string, onEdits?: PreparationEditSink): string {
    if (!text.includes("=")) {
      return text;
    }
    const contextRedacted = redactAssignmentValues(
      redactAssignmentValues(text, "encoded", onEdits),
      "context",
      onEdits,
    );
    if (!contextRedacted.includes("&")) {
      return contextRedacted;
    }
    if (FORM_BODY_RE.test(contextRedacted)) {
      return redactAssignmentValues(contextRedacted, "form", onEdits);
    }
    const substringEdits: RedactionEdit[] = [];
    const redacted = contextRedacted.replace(
      FORM_BODY_SUBSTRING_RE,
      (match, prefix: string, body: string, offset: number) => {
        const redactedBody = redactAssignmentValues(
          body,
          "form",
          onEdits
            ? (edits) => {
                for (const edit of edits) {
                  substringEdits.push({
                    ...edit,
                    start: offset + prefix.length + edit.start,
                    end: offset + prefix.length + edit.end,
                  });
                }
              }
            : undefined,
        );
        return redactedBody === body ? match : `${prefix}${redactedBody}`;
      },
    );
    if (substringEdits.length > 0) {
      onEdits?.(substringEdits);
    }
    return redactAssignmentValues(
      redactAssignmentValues(redacted, "encoded", onEdits),
      "context",
      onEdits,
    );
  }

  function redactFormBody(text: string, onEdits?: PreparationEditSink): string {
    // Every form grammar requires a literal assignment separator, including encoded keys.
    if (!text.includes("=")) {
      return text;
    }
    if (FORM_BODY_LINE_BREAK_SPLIT_RE.test(text)) {
      let offset = 0;
      return text
        .split(FORM_BODY_LINE_BREAK_SPLIT_RE)
        .map((segment) => {
          const result = FORM_BODY_LINE_BREAK_SEGMENT_RE.test(segment)
            ? segment
            : redactFormBodyLine(
                segment,
                onEdits
                  ? (edits) =>
                      onEdits(
                        edits.map((edit) => ({
                          ...edit,
                          start: offset + edit.start,
                          end: offset + edit.end,
                        })),
                      )
                  : undefined,
              );
          offset += result.length;
          return result;
        })
        .join("");
    }
    return redactFormBodyLine(text, onEdits);
  }

  return { redactAssignmentValues, redactFormBody };
}
