// Control UI view renders overview attention screen content.
import { html, nothing } from "lit";
import { icons, type IconName } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import type { AttentionItem } from "../../ui/types.ts";

export type OverviewAttentionProps = {
  items: AttentionItem[];
};

function severityClass(severity: string) {
  if (severity === "error") {
    return "danger";
  }
  if (severity === "warning") {
    return "warn";
  }
  return "";
}

function attentionIcon(name: string) {
  if (name in icons) {
    return icons[name as IconName];
  }
  return icons.radio;
}

export function renderOverviewAttention(props: OverviewAttentionProps) {
  if (props.items.length === 0) {
    return nothing;
  }

  return html`
    <section class="card ov-attention">
      <div class="card-title">${t("overview.attention.title")}</div>
      <div class="ov-attention-list">
        ${props.items.map(
          (item) => html`
            <div class="ov-attention-item ${severityClass(item.severity)}">
              <span class="ov-attention-icon">${attentionIcon(item.icon)}</span>
              <div class="ov-attention-body">
                <div class="ov-attention-title">${item.title}</div>
                <div class="muted">${item.description}</div>
              </div>
              ${item.href
                ? html`<a
                    class="ov-attention-link"
                    href=${item.href}
                    target=${item.external ? EXTERNAL_LINK_TARGET : nothing}
                    rel=${item.external ? buildExternalLinkRel() : nothing}
                    >${t("common.docs")}</a
                  >`
                : nothing}
            </div>
          `,
        )}
      </div>
    </section>
  `;
}
