import { parseSemver } from "../../infra/runtime-guard.js";
import { compareSemverStrings } from "../../infra/update-check.js";

export type ChangelogSection = {
  title: string;
  items: string[];
};

export type ChangelogRelease = {
  version: string;
  sections: ChangelogSection[];
};

export type BehaviorDiffDirection = "upgrade" | "downgrade" | "none";

export type BehaviorDiff = {
  fromVersion: string;
  toVersion: string;
  direction: BehaviorDiffDirection;
  releases: ChangelogRelease[];
};

const RELEASE_HEADING_RE = /^##\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\s*$/;
const SECTION_HEADING_RE = /^###\s+(.+?)\s*$/;
const BULLET_RE = /^-\s+(.*\S)\s*$/;

export function normalizeVersionArg(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim().replace(/^v/i, "");
  return parseSemver(trimmed) ? trimmed : null;
}

export function parseChangelogReleases(changelog: string): ChangelogRelease[] {
  const lines = changelog.split(/\r?\n/);
  const releases: ChangelogRelease[] = [];
  let currentRelease: ChangelogRelease | null = null;
  let currentSection: ChangelogSection | null = null;

  for (const line of lines) {
    const releaseMatch = line.match(RELEASE_HEADING_RE);
    if (releaseMatch) {
      currentRelease = {
        version: releaseMatch[1],
        sections: [],
      };
      releases.push(currentRelease);
      currentSection = null;
      continue;
    }

    if (!currentRelease) {
      continue;
    }

    const sectionMatch = line.match(SECTION_HEADING_RE);
    if (sectionMatch) {
      currentSection = {
        title: sectionMatch[1],
        items: [],
      };
      currentRelease.sections.push(currentSection);
      continue;
    }

    if (!currentSection) {
      continue;
    }

    const bulletMatch = line.match(BULLET_RE);
    if (bulletMatch) {
      currentSection.items.push(bulletMatch[1]);
      continue;
    }

    const continuation = line.trim();
    if (continuation.length === 0 || currentSection.items.length === 0) {
      continue;
    }
    const last = currentSection.items[currentSection.items.length - 1] ?? "";
    currentSection.items[currentSection.items.length - 1] = `${last} ${continuation}`.trim();
  }

  return releases;
}

export function getPreviousBehaviorHint(sectionTitle: string): string {
  const key = sectionTitle.trim().toLowerCase();
  if (key.includes("fix")) {
    return "A bug or regression could occur in earlier versions.";
  }
  if (key.includes("breaking")) {
    return "Legacy behavior was accepted and is now changed/incompatible.";
  }
  if (key.includes("added") || key.includes("new")) {
    return "This capability was missing in earlier versions.";
  }
  if (key.includes("change") || key.includes("highlight")) {
    return "Behavior worked differently in earlier versions.";
  }
  return "Behavior differed in earlier versions.";
}

export function buildBehaviorDiff(params: {
  changelog: string;
  fromVersion: string;
  toVersion: string;
}): BehaviorDiff {
  const from = params.fromVersion;
  const to = params.toVersion;
  const cmp = compareSemverStrings(from, to);
  const direction: BehaviorDiffDirection =
    cmp == null || cmp === 0 ? "none" : cmp < 0 ? "upgrade" : "downgrade";
  const releases = parseChangelogReleases(params.changelog);

  const inRange = (version: string): boolean => {
    const cFrom = compareSemverStrings(version, from);
    const cTo = compareSemverStrings(version, to);
    if (cFrom == null || cTo == null) {
      return false;
    }
    if (direction === "upgrade") {
      return cFrom > 0 && cTo <= 0;
    }
    if (direction === "downgrade") {
      return cTo > 0 && cFrom <= 0;
    }
    return false;
  };

  return {
    fromVersion: from,
    toVersion: to,
    direction,
    releases: releases.filter((release) => inRange(release.version)),
  };
}
