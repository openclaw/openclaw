import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const shared = en.aboutPage;

const enAbout = {
  aboutPage: {
    productName: "OpenClaw",
    tagline: "Your personal AI assistant, running on your own devices.",
    waveHello: "Wave hello to Clawd",
    linksLabel: "Community and resources",
    linkWebsite: "Website",
    linkDocs: "Docs",
    linkSupport: "Support",
    linkGitHub: "GitHub",
    linkDiscord: "Discord",
    linkX: "X (Twitter)",
    linkChangelog: "Changelog",
    license: "© 2026 OpenClaw Foundation — MIT License.",
    artifactTitle: "Control UI",
    artifactDetails: shared.artifactDetails,
    version: "Version",
    commit: shared.commit,
    branch: "Branch",
    built: shared.built,
    unavailable: shared.unavailable,
    copyCommit: shared.copyCommit,
    copiedCommit: shared.copiedCommit,
    gateway: shared.gateway,
  },
} satisfies TranslationMap;

export const registerAboutEnglish = Object.assign(
  () => {
    Object.assign(en.aboutPage, enAbout.aboutPage);
  },
  { catalog: enAbout },
);
