import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Settings and Lobsterdex share this copy; neither is needed for startup.
const enPreferences = {
  quickSettings: {
    language: "Language",
    model: {
      title: "Model & Effort",
      model: "Model",
      thinking: "Effort",
      fastMode: "Speed",
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
      title: "Security",
      accessTitle: "Access",
      agentsTitle: "Agents",
      forwardingTitle: "Approval forwarding",
      policiesTitle: "Policies",
      gatewayAuth: "Gateway authentication",
      gatewayAuthValue: {
        none: "None",
        token: "Token",
        password: "Password",
        "trusted-proxy": "Trusted proxy",
        unknown: "Unknown",
      },
      networkAccess: "Network access",
      tailscaleExposure: {
        inactive: "Requested Tailscale access is not active.",
        externalFunnel: "External Funnel",
      },
      networkAccessValue: {
        unknown: "Unknown",
        default: "Default",
        loopback: "Loopback",
        lan: "LAN",
        tailnet: "Tailnet",
        auto: "Automatic",
        custom: "Custom address",
        serve: "Tailscale Serve",
        funnel: "Tailscale Funnel",
        via: "Remote",
        reportedLoopback: "This computer only",
        reportedAllInterfaces: "All interfaces",
        reportedTailnet: "Tailnet",
        reportedHost: "Custom address",
        reportedServe: "Tailnet",
        reportedFunnel: "Public internet",
      },
      networkAccessDetail: {
        configured: "As configured. A startup flag can override this.",
        configuredHost: "{host}, as configured. A startup flag can override this.",
        via: "Reached through {host}.",
        listening: "Listening on {host}.",
        reportedServe: "Through Tailscale Serve.",
        reportedFunnel: "Through Tailscale Funnel.",
      },
      devicesDescription: "Manage paired devices and connection requests.",
      execPolicy: "Command permissions",
      execPolicyValue: {
        deny: "Deny",
        allowlist: "Allowlist",
        ask: "Ask",
        auto: "Auto",
        full: "Full",
        unknown: "Unknown",
      },
      execPolicyDescription: {
        deny: "Agents can’t run commands.",
        allowlist: "Agents run allowlisted commands only.",
        ask: "Agents ask before commands the allowlist doesn’t cover.",
        auto: "A reviewer checks commands the allowlist doesn't cover, then asks.",
        full: "Agents run commands without asking.",
      },
      browserEnabled: "Browser tools",
      toolProfile: "Available tools",
      toolProfileUnset: "Default",
      toolProfileDescription: {
        default: "Core tools, without optional plugin tools.",
        minimal: "Session status and Gateway maintenance.",
        coding: "Files, commands, web, sessions, and memory.",
        messaging: "Messaging and sessions.",
        full: "Core tools and optional plugin tools.",
        custom: "A custom profile set in the config file.",
      },
      approvalsDescription: "Past decisions and standing grants.",
    },
    system: {
      gatewayHost: "This computer",
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
      deviceOnly: "This preference is saved only on this device.",
      shortcutsLocalOnly:
        "Shortcuts are saved only on this device because their previous sync state is missing. Edit a shortcut to sync again.",
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
