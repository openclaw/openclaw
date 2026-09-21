import { stripAssistantInternalScaffolding } from "./assistant-visible-text.ts";

/** Returns whether an appended delta completes hidden assistant scaffolding. */
export function appendedTextActivatesAssistantScaffolding(
  currentText: string,
  appendedText: string,
): boolean {
  const candidateStarts: number[] = [];
  if (/[=:]/.test(appendedText)) {
    candidateStarts.push(
      Math.max(currentText.lastIndexOf("\n"), currentText.lastIndexOf("\r")) + 1,
    );
  }
  if (appendedText.includes(">")) {
    candidateStarts.push(currentText.lastIndexOf("<"));
  }
  if (appendedText.includes("]")) {
    candidateStarts.push(currentText.lastIndexOf("["));
  }
  // Line-oriented trace rules can activate when a plain command word arrives
  // after a long prefix. A newline is the canonical boundary for those rules;
  // do not require punctuation from the appended suffix.
  if (/[\r\n]/.test(appendedText)) {
    candidateStarts.push(
      Math.max(currentText.lastIndexOf("\n"), currentText.lastIndexOf("\r")) + 1,
    );
  }

  return candidateStarts.some((start) => {
    if (start < 0) {
      return false;
    }
    const candidate = `${currentText.slice(start)}${appendedText}`;
    return stripAssistantInternalScaffolding(candidate) !== candidate;
  });
}
