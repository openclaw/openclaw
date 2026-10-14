import type { TranscriptsGetResult } from "@openclaw/gateway-protocol";
import MarkdownIt from "markdown-it";
import { Show } from "solid-js";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { sanitizedHtml } from "../../lib/solid-dom.ts";
import type { TranscriptsViewProps } from "./view-types.ts";

const summaryParser = new MarkdownIt("commonmark");

function summaryNotesMarkdown(markdown: string): string {
  const lines = markdown.split(/\r\n?|\n/);
  const tokens = summaryParser.parse(markdown, {});
  const notes: string[] = [];
  let keptFrom = 0;
  let transcript = false;
  for (const [index, token] of tokens.entries()) {
    if (
      token.type !== "heading_open" ||
      token.level !== 0 ||
      (token.tag !== "h1" && token.tag !== "h2") ||
      !token.map
    ) {
      continue;
    }
    const line = token.map[0];
    if (transcript) {
      keptFrom = line;
      transcript = false;
    }
    // Preserve historical Markdown-only notes and fenced heading examples.
    if (token.tag === "h2" && tokens[index + 1]?.content.trim() === "Transcript") {
      notes.push(lines.slice(keptFrom, line).join("\n"));
      transcript = true;
    }
  }
  if (!transcript) {
    notes.push(lines.slice(keptFrom).join("\n"));
  }
  return notes.join("\n");
}

export function MeetingSummary(props: {
  page: TranscriptsGetResult;
  generation: TranscriptsViewProps["summaryGeneration"];
  onRetry: TranscriptsViewProps["onSummaryRetry"];
}) {
  const markdown = () => {
    const summary = props.page.summary;
    const titleLine = `# ${props.page.session.title || props.page.session.sessionId}\n`;
    return summaryNotesMarkdown(
      summary
        ? summary.markdown.startsWith(titleLine)
          ? summary.markdown.slice(titleLine.length)
          : summary.markdown
        : "",
    );
  };
  return (
    <section class="transcripts-summary">
      {props.page.summary ? (
        <>
          {props.page.session.active ? (
            <p class="transcripts-caption" role="status">
              {t("meetings.liveSummaryHint")}
            </p>
          ) : null}
          <p class="transcripts-caption">
            {props.page.summary?.source ? (
              <>
                {t(
                  props.page.summary.source === "model"
                    ? "transcripts.modelNotes"
                    : "transcripts.heuristicNotes",
                )}
                {props.page.summary.model ? ` · ${props.page.summary.model}` : null} ·{" "}
              </>
            ) : null}
            {t("transcripts.generatedAt", {
              time: props.page.summary?.generatedAt
                ? new Date(props.page.summary.generatedAt).toLocaleString()
                : t("transcripts.unknown"),
            })}
          </p>
          <Show when={markdown()} keyed>
            {(content) => (
              <div
                class="meetings-notes markdown"
                ref={sanitizedHtml(() =>
                  toSanitizedMarkdownHtml(content, { mode: "document", remoteImages: false }),
                )}
              />
            )}
          </Show>
          <p class="transcripts-caption">{t("transcripts.summaryHint")}</p>
        </>
      ) : props.generation?.kind === "loading" ? (
        <div class="meetings-loading" role="status" aria-live="polite">
          <span class="btn__spinner" aria-hidden="true" />
          <span>{t("transcripts.generatingSummary")}</span>
        </div>
      ) : props.generation?.kind === "error" ? (
        <div role="alert">
          <p>
            {t("transcripts.summaryError")} {props.generation.message}
          </p>
          <button class="btn" onClick={() => props.onRetry?.()}>
            {t("common.retry")}
          </button>
        </div>
      ) : (
        <p role="status">
          {t(
            props.page.session.utteranceCount === 0
              ? props.page.session.active
                ? "meetings.waitingForSpeech"
                : "meetings.noSpeech"
              : "transcripts.noSummary",
          )}
        </p>
      )}
    </section>
  );
}
