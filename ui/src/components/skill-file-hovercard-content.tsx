import type { SkillsFileGetResult } from "@openclaw/gateway-protocol";
import { createMemo, For, onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../lib/reactive/i18n.ts";
import { highlightCodeHtml } from "./markdown-code-blocks.ts";
import { createHovercardControlRef } from "./portaled-hovercard-focus.ts";
import { CopyButton } from "./solid/copy-button.tsx";
import { Icon } from "./solid/icon.tsx";
import { SanitizedHtml } from "./solid/sanitized-html.tsx";

const MAX_PREVIEW_LINES = 400;

export function SkillRead(props: {
  client: GatewayBrowserClient;
  path: string;
  agentId?: string;
  signal: AbortSignal;
  onOpen: (file: SkillsFileGetResult) => void;
  onClose: () => void;
  onPosition: () => void;
}) {
  const file = createMemo(() =>
    props.client.request<SkillsFileGetResult>(
      "skills.files.get",
      { agentId: props.agentId, path: props.path },
      { signal: props.signal },
    ),
  );
  const lines = createMemo(() => {
    const source = file().content.replace(/\r\n/g, "\n").split("\n");
    if (source.at(-1) === "") {
      source.pop();
    }
    return source;
  });
  const preview = createMemo(() => {
    const source = lines();
    const frontmatterEnd = source[0] === "---" ? source.indexOf("---", 1) : -1;
    return source.slice(0, MAX_PREVIEW_LINES).map((line, index) => ({
      number: index + 1,
      html: highlightCodeHtml(line || " ", index <= frontmatterEnd ? "yaml" : "markdown"),
    }));
  });
  onSettled(() => props.onPosition());
  return (
    <>
      <header class="skill-file-hovercard__header">
        <span class="skill-file-hovercard__icon" aria-hidden="true">
          <Icon name="fileText" />
        </span>
        <strong>{file().path.replaceAll("\\", "/").split("/").at(-1)}</strong>
        <span class="skill-file-hovercard__name">{file().name}</span>
        <div class="skill-file-hovercard__actions">
          <CopyButton
            ref={createHovercardControlRef()}
            text={file().content}
            idleLabel={t("filePreview.copyFile")}
            bare
          />
          <button
            ref={createHovercardControlRef()}
            type="button"
            title={t("filePreview.skill.open")}
            aria-label={t("filePreview.skill.open")}
            onClick={() => props.onOpen(file())}
          >
            <Icon name="maximize" />
          </button>
          <button
            ref={createHovercardControlRef()}
            type="button"
            aria-label={t("common.close")}
            onClick={() => props.onClose()}
          >
            <Icon name="x" />
          </button>
        </div>
      </header>
      <div
        ref={createHovercardControlRef()}
        class="skill-file-hovercard__source"
        tabindex={0}
        aria-label={t("filePreview.skill.source")}
      >
        <For each={preview()}>
          {(line) => (
            <div class="skill-file-hovercard__line">
              <span class="skill-file-hovercard__number" aria-hidden="true">
                {line.number}
              </span>
              <SanitizedHtml tag="code" html={line.html} />
            </div>
          )}
        </For>
      </div>
      <footer class="skill-file-hovercard__footer">
        <span class="skill-file-hovercard__path" title={file().path}>
          {file().path}
        </span>
        <span>
          {t("filePreview.skill.lines", {
            count: String(preview().length),
            total: String(lines().length),
          })}
        </span>
      </footer>
    </>
  );
}
