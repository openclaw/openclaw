import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enApps = {
  appsPage: {
    heroTitle: "Take OpenClaw everywhere",
    heroTagline:
      "Companion apps for your phone, watch, desktop, and browser — plus plugins to extend what your agent can do.",
    sectionMobile: "On your phone",
    havePhone: "Already have the app?",
    pairDevice: "Pair your device",
    sectionWatch: "On your wrist",
    sectionDesktop: "On your desktop",
    sectionBrowser: "In your browser",
    sectionCommunity: "Community",
    badgeBundledIos: "Included with the iOS app",
    badgeBundledAndroid: "Included with the Android app",
    ctaAppStore: "App Store",
    ctaPlayStore: "Google Play",
    ctaDownload: "Download",
    ctaOpenMac: "Open in Mac app",
    ctaDocs: "Docs",
    ctaSetupGuide: "Setup guide",
    ctaChromeWebStore: "Chrome Web Store",
    ctaOpenPlugins: "Open plugins",
    ctaBrowseClawHub: "Browse ClawHub",
    linkDiscord: "Discord community",
    linkDocs: "Docs",
    linkSupport: "Support",
    cards: {
      ios: {
        title: "iPhone",
        desc: "Chat, talk, approve actions, and share into OpenClaw from iOS.",
      },
      android: {
        title: "Android",
        desc: "Your Android phone as a full OpenClaw device — chat, camera, and Canvas.",
      },
      appleWatch: {
        title: "Apple Watch",
        desc: "Conversations and quick replies from your wrist.",
      },
      wearOs: {
        title: "Wear OS",
        desc: "The Android companion extends OpenClaw to your watch.",
      },
      macos: {
        title: "macOS",
        desc: "Menu bar companion for OpenClaw — notifications, approvals, and quick replies.",
      },
      windows: {
        title: "Windows",
        desc: "The Windows companion connects your PC as an OpenClaw device.",
      },
      linux: {
        title: "Linux",
        desc: "Native desktop app — .deb and AppImage builds.",
      },
      chrome: {
        title: "Chrome extension",
        desc: "Let OpenClaw drive your existing Chrome — tabs, pages, and forms.",
      },
      plugins: {
        title: "Plugins and ClawHub",
        desc: "Extend OpenClaw with channels, tools, and skills from the community.",
      },
    },
  },
} satisfies TranslationMap;

export const registerAppsEnglish = Object.assign(
  () => {
    Object.assign(en, enApps);
  },
  { catalog: enApps },
);
