import { Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { StrokeIcon } from "../../components/solid/stroke-icon.tsx";
import { resolveMacFormFactorFromName } from "../../lib/mac-form-factor.ts";
import type { DevicePlacementOption } from "./device-placement.ts";

export function DevicePoolIcon() {
  return (
    <StrokeIcon>
      <rect x="2" y="7" width="14" height="11" />
      <path d="M6 7V3h16v12h-6M6 22h6M9 18v4" />
    </StrokeIcon>
  );
}
function MacDeviceIcon(props: { form: "laptop" | "mini" | "studio" }) {
  return (
    <StrokeIcon>
      {props.form === "laptop" ? (
        <>
          <path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z" />
          <path d="M20.054 15.987H3.946" />
        </>
      ) : props.form === "mini" ? (
        <>
          <path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
          <path d="M21.946 12.013H2.054M6 16h.01M10 16h.01" />
        </>
      ) : (
        <>
          <path d="m3 8 3-4h12l3 4v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          <path d="M3 8h18M6 15h2M11 15h2M17 15h.01" />
        </>
      )}
    </StrokeIcon>
  );
}
export function EnvironmentDeviceIcon(props: { device?: DevicePlacementOption }) {
  const form = () => {
    const platform = props.device?.platform?.trim();
    if (platform && !/^(?:darwin|macos|mac os(?: x)?)\b/i.test(platform)) {
      return undefined;
    }
    const value = resolveMacFormFactorFromName(props.device?.label);
    return value === "laptop" || value === "mini" || value === "studio" ? value : undefined;
  };
  return (
    <Show when={form()} fallback={<Icon name="monitor" />}>
      {(current) => (
        <span class="new-session-page__device-icon" data-form={current()}>
          <MacDeviceIcon form={current()} />
        </span>
      )}
    </Show>
  );
}
