import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";

const GITHUB_URL_CANDIDATE = /https:\/\/[^\s<>()\]}'"`]+/giu;
const MAX_REFERENCES = 3;

/** Select convenience links from accepted messages without inferring session work. */
export function selectSessionIssueReferences(
  visit: (consume: (message: unknown) => void) => void,
  repository: { owner: string; repo: string },
  host: string,
): Array<{ number: number; url: string }> {
  const issues = new Map<number, { number: number; url: string }>();
  visit((message) => {
    const record = asOptionalRecord(message);
    if (record?.role !== "assistant" && record?.role !== "user") {
      return;
    }
    const texts =
      record.role === "user"
        ? [extractTextFromChatContent(record.content) ?? ""]
        : !Array.isArray(record.openclawDisplayContent) && typeof record.content === "string"
          ? [record.content]
          : readAssistantDisplayContent(record).flatMap((block) =>
              block.type === "text" && typeof block.text === "string" ? [block.text] : [],
            );
    for (const text of texts) {
      for (const match of text.matchAll(GITHUB_URL_CANDIDATE)) {
        try {
          const url = new URL(match[0].replace(/[.,;:!?]+$/u, ""));
          const [, owner, repo, kind, number] = url.pathname.split("/");
          if (
            url.protocol !== "https:" ||
            url.hostname !== host ||
            url.username ||
            url.password ||
            url.port ||
            !owner ||
            !repo ||
            kind !== "issues" ||
            !number ||
            !/^[1-9]\d{0,9}$/u.test(number) ||
            decodeURIComponent(owner).toLowerCase() !== repository.owner.toLowerCase() ||
            decodeURIComponent(repo).toLowerCase() !== repository.repo.toLowerCase()
          ) {
            continue;
          }
          const issue = {
            number: Number(number),
            url: `https://${host}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/issues/${number}`,
          };
          issues.delete(issue.number);
          issues.set(issue.number, issue);
          if (issues.size > MAX_REFERENCES) {
            for (const oldest of issues.keys()) {
              issues.delete(oldest);
              break;
            }
          }
        } catch {
          // Malformed pasted URLs are not references.
        }
      }
    }
  });
  return [...issues.values()].toReversed();
}
