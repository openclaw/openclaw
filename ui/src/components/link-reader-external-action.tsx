import { t } from "../lib/reactive/i18n.ts";
import type { LinkReaderTarget } from "./link-reader-target.ts";
import { iconButtonClass } from "./solid/icon-button.tsx";
import { Icon } from "./solid/icon.tsx";

export function LinkReaderExternalAction(props: { target: LinkReaderTarget }) {
  const label = () => t("linkReader.openExternal", { provider: props.target.reader.label });
  return (
    <openclaw-tooltip prop:content={label()}>
      <a
        class={[iconButtonClass({ size: 28 }), "lr-external"]}
        href={props.target.href}
        target="_blank"
        rel="noopener noreferrer"
        data-link-reader-external=""
        aria-label={label()}
      >
        <Icon name="externalLink" />
      </a>
    </openclaw-tooltip>
  );
}
