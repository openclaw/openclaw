import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Settings and Lobsterdex share this copy; neither is needed for startup.
const enPreferences = {
  quickSettings: {
    language: "Language",
    model: {
      title: "Model & Thinking",
      model: "Model",
      thinking: "Thinking",
      fastMode: "Fast Mode",
      default: "Default",
      modelPolicy: "Model policy",
      thinkingLevels: {
        off: "Off",
        low: "Low",
        medium: "Medium",
        high: "High",
      },
      fastModes: {
        auto: "Auto",
        fast: "Fast",
        standard: "Standard",
        on: "On",
        off: "Off",
      },
    },
    channels: {
      title: "Channels",
      connect: "Connect →",
    },
    appearance: {
      lobsterVisits: en.quickSettings.appearance.lobsterVisits,
      lobsterVisitsOn: "Drops by occasionally",
      lobsterVisitsThemeHidden:
        "The lobster stays home while the {theme} theme is active. Other visitors still drop by.",
      lobsterVisitsOff: "Never visits",
      lobsterSounds: "Lobster sounds",
      lobsterSoundsOn: "Tiny blubs when touched",
      lobsterSoundsOff: "Silent",
      lobsterdex: "Lobsterdex",
      lobsterdexSeen: "{seen}/{total} visited",
      lobsterdexFirstVisited: "{name} · first visited {date}",
      lobsterdexCardFirstVisited: "First visited {date}",
      lobsterdexCardShinySeen: "✦ Shiny spotted {date}",
      lobsterdexCardCopyLink: "Copy link",
      lobsterdexOpen: "Open Lobsterdex",
      lobsterdexThemeHidden:
        "This theme hides Lobsterdex. Your collection and preferences are preserved.",
    },
    security: {
      intro: "Review gateway access, tool policy, device authentication, and approvals.",
      title: "Security",
      gatewayAuth: "Gateway auth",
      execPolicy: "Exec policy",
      browserEnabled: "Browser enabled",
      toolProfile: "Available tools",
      toolProfileDefault:
        "Using core and default plugin tools. Choose Full to include available optional plugin tools.",
    },
    system: {
      gatewayHost: "Gateway Host",
      up: "Up {duration}",
      cpu: "CPU",
      memory: "Memory",
      disk: "Disk",
      usage: "{label} usage",
      loadAverage: "Load average: {values}",
      core: "{count} core",
      cores: "{count} cores",
      load: "load",
      used: "used",
      freeOf: "{free} free of {total}",
      runtime: "Node {version} · PID {pid}",
    },
    personal: {
      browserOnly: en.quickSettings.personal.browserOnly,
    },
  },
} satisfies TranslationMap;

export const registerPreferencesEnglish = Object.assign(
  () => {
    const { appearance, personal, ...quickSettings } = enPreferences.quickSettings;
    Object.assign(en.quickSettings, quickSettings);
    Object.assign(en.quickSettings.appearance, appearance);
    Object.assign(en.quickSettings.personal, personal);
  },
  { catalog: enPreferences },
);
