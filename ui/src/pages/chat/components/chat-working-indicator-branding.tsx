import { Show } from "solid-js";
import type { ThemeBranding } from "../../../../../packages/gateway-protocol/src/theme.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { ThemeBrandIcon } from "../../../components/theme-brand-icon.tsx";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";

export function WorkingBrandGlyph(props: { branding: ThemeBranding; claw: "claw" | "lobster" }) {
  return (
    <Show
      when={props.branding.brandIcon === "claw" || props.branding.brandIcon === "mark"}
      fallback={<ThemeBrandIcon branding={props.branding} />}
    >
      <Icon name={props.branding.brandIcon === "claw" ? props.claw : "mark"} />
    </Show>
  );
}

export function outputTokensLabel(outputTokens: number): string {
  return outputTokens === 1
    ? t("chat.turnRecap.tokensOne")
    : t("chat.turnRecap.tokens", { count: formatCompactTokenCount(outputTokens) });
}
