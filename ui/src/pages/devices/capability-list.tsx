/// <reference lib="es2024.object" />

import { createMemo, For, Show } from "solid-js";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerDevicesEnglish);

/** Capability id to its i18n leaf under `devices.capabilities`. */
const CAPABILITY_COPY_KEYS = new Map<string, string>(
  Object.entries({
    browser: "browser",
    canvas: "canvas",
    screen: "screen",
    computer: "computer",
    file: "file",
    system: "system",
    mcp: "mcp",
    "local-inference": "localInference",
    camera: "camera",
    talk: "talk",
    location: "location",
    notifications: "notifications",
    contacts: "contacts",
    calendar: "calendar",
    reminders: "reminders",
    device: "device",
    photos: "photos",
    sms: "sms",
    health: "health",
    motion: "motion",
  }),
);

const SESSION_RUNTIME_CAPABILITIES: ReadonlySet<string> = new Set([
  "claude-sessions",
  "codex-cli-sessions",
  "codex-app-server-threads",
  "opencode-sessions",
  "pi-sessions",
]);

// Node-controlled lists are unbounded; grouping does not remove the inventory's render cap.
const CAPABILITY_LIMIT = 16;

/** Reads as one sentence; each item keeps its explanation in the title. */
export function CapabilityList(props: { caps: readonly string[] }) {
  const list = createMemo(() => {
    const unique = new Set(
      props.caps.map((cap) => (cap === "codex-cli-session-source" ? "codex-cli-sessions" : cap)),
    );
    const { runtimes = [], capabilities = [] } = Object.groupBy(unique, (cap) =>
      SESSION_RUNTIME_CAPABILITIES.has(cap) ? "runtimes" : "capabilities",
    );
    const visible = capabilities.slice(0, CAPABILITY_LIMIT - (runtimes.length > 0 ? 1 : 0));
    return { runtimes, visible, overflow: capabilities.length - visible.length };
  });
  return (
    <span class="device-capabilities">
      <For each={list().visible}>
        {(cap, index) => (
          <>
            {index() > 0 ? ", " : ""}
            <NamedCapability cap={cap} />
          </>
        )}
      </For>
      <Show when={list().overflow > 0}>
        {", "}
        <span
          class="device-capability"
          title={t("devices.capabilities.overflow", { count: String(list().overflow) })}
        >
          +{list().overflow}
        </span>
      </Show>
      <Show when={list().runtimes.length > 0}>
        {list().visible.length > 0 ? ", " : ""}
        <span class="device-capability" title={list().runtimes.join(", ")}>
          {t(
            list().runtimes.length === 1
              ? "devices.capabilities.runtime"
              : "devices.capabilities.runtimes",
            { count: String(list().runtimes.length) },
          )}
        </span>
      </Show>
    </span>
  );
}

function NamedCapability(props: { cap: string }) {
  const copy = (part: "label" | "description") => {
    const key = CAPABILITY_COPY_KEYS.get(props.cap);
    return key ? t(`devices.capabilities.${key}.${part}`) : props.cap;
  };
  return (
    <span class="device-capability" title={copy("description")}>
      {copy("label")}
    </span>
  );
}
