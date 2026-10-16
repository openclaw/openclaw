import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerDevicesEnglish);

type CapabilityPresentation = {
  icon: IconName;
  /** i18n leaf under `devices.capabilities`. */
  key: string;
};

const CAPABILITY_PRESENTATIONS = new Map<string, CapabilityPresentation>(
  Object.entries({
    browser: { icon: "globe", key: "browser" },
    canvas: { icon: "panelsTopLeft", key: "canvas" },
    screen: { icon: "monitor", key: "screen" },
    computer: { icon: "monitorSmartphone", key: "computer" },
    file: { icon: "folder", key: "file" },
    system: { icon: "terminal", key: "system" },
    mcp: { icon: "plug", key: "mcp" },
    "local-inference": { icon: "cpu", key: "localInference" },
    camera: { icon: "camera", key: "camera" },
    talk: { icon: "mic", key: "talk" },
    location: { icon: "target", key: "location" },
    notifications: { icon: "bell", key: "notifications" },
    contacts: { icon: "users", key: "contacts" },
    calendar: { icon: "calendarClock", key: "calendar" },
    reminders: { icon: "listChecks", key: "reminders" },
    device: { icon: "smartphone", key: "device" },
    photos: { icon: "image", key: "photos" },
    sms: { icon: "messageSquare", key: "sms" },
    health: { icon: "activity", key: "health" },
    motion: { icon: "radio", key: "motion" },
  } satisfies Record<string, CapabilityPresentation>),
);

const SESSION_RUNTIME_CAPABILITIES: ReadonlySet<string> = new Set([
  "claude-sessions",
  "codex-cli-sessions",
  "codex-app-server-threads",
  "opencode-sessions",
  "pi-sessions",
]);

// Node-controlled lists are unbounded; grouping does not remove the inventory's render cap.
const CAPABILITY_CHIP_LIMIT = 16;

function CapabilityChip(props: { icon: JSX.Element; label: string; title: string }) {
  return (
    <span class="device-capability" role="listitem" title={props.title}>
      <span class="device-capability__icon" aria-hidden="true">
        {props.icon}
      </span>
      <span>{props.label}</span>
    </span>
  );
}

export function CapabilityChips(props: { caps: readonly string[] }) {
  const unique = createMemo(() => [
    ...new Set(
      props.caps.map((cap) => (cap === "codex-cli-session-source" ? "codex-cli-sessions" : cap)),
    ),
  ]);
  const runtimes = createMemo(() =>
    unique().filter((cap) => SESSION_RUNTIME_CAPABILITIES.has(cap)),
  );
  const capabilities = createMemo(() =>
    unique().filter((cap) => !SESSION_RUNTIME_CAPABILITIES.has(cap)),
  );
  const visible = createMemo(() =>
    capabilities().slice(0, CAPABILITY_CHIP_LIMIT - (runtimes().length > 0 ? 1 : 0)),
  );
  const overflow = () => capabilities().length - visible().length;
  return (
    <Show when={props.caps.length > 0}>
      <div class="device-capabilities" role="list" aria-label={t("devices.inventory.capabilities")}>
        <Show when={runtimes().length > 0}>
          <CapabilityChip
            icon={<Icon name="squareTerminal" />}
            label={t(
              runtimes().length === 1
                ? "devices.capabilities.runtime"
                : "devices.capabilities.runtimes",
              { count: String(runtimes().length) },
            )}
            title={runtimes().join(", ")}
          />
        </Show>
        <For each={visible()}>{(cap) => <NamedCapability cap={cap} />}</For>
        <Show when={overflow() > 0}>
          <span
            class="device-capability device-capability--overflow"
            role="listitem"
            title={t("devices.capabilities.overflow", { count: String(overflow()) })}
          >
            +{overflow()}
          </span>
        </Show>
      </div>
    </Show>
  );
}

function NamedCapability(props: { cap: string }) {
  const presentation = () => CAPABILITY_PRESENTATIONS.get(props.cap);
  const copy = (part: "label" | "description") => {
    const current = presentation();
    return current ? t(`devices.capabilities.${current.key}.${part}`) : props.cap;
  };
  return (
    <CapabilityChip
      icon={<Icon name={presentation()?.icon ?? "puzzle"} />}
      label={copy("label")}
      title={copy("description")}
    />
  );
}
