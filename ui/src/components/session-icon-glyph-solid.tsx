import { Show } from "solid-js";
import {
  SESSION_ICON_GLYPH_IDS,
  SESSION_ICON_SVG_DATA_URL_PREFIX,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { Icon } from "./solid/icon.tsx";

export function SessionIconGraphic(props: { icon: string }) {
  const glyph = () => SESSION_ICON_GLYPH_IDS.find((id) => id === props.icon);
  return (
    <>
      {props.icon.startsWith(SESSION_ICON_SVG_DATA_URL_PREFIX) ? (
        <img src={props.icon} alt="" aria-hidden="true" />
      ) : (
        <Show when={glyph()}>{(icon) => <Icon name={icon()} />}</Show>
      )}
    </>
  );
}
