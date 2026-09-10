import type { SkillLibraryEntry } from "../../../../packages/gateway-protocol/src/index.ts";
import type { SkillStatusEntry } from "../../api/types.ts";
import { clawHubSkillRef, type ClawHubSearchResult } from "../../lib/skills/clawhub-search.ts";

export type SkillDiscoveryEntry = {
  id: string;
  name: string;
  description: string;
  attribution: string;
  skill?: SkillStatusEntry;
  library?: SkillLibraryEntry;
  remote?: ClawHubSearchResult;
};

function installedReference(skill: SkillStatusEntry): string | null {
  const link = skill.clawhub;
  if (!link?.valid) {
    return null;
  }
  return link.requestedReference ?? (link.ownerHandle ? `@${link.ownerHandle}/${link.slug}` : null);
}

export function skillDiscoveryEntries(params: {
  skills: SkillStatusEntry[];
  libraries: SkillLibraryEntry[];
  results: ClawHubSearchResult[];
  query: string;
}): SkillDiscoveryEntry[] {
  const entries: SkillDiscoveryEntry[] = params.libraries
    .filter((entry) => !entry.removed)
    .map((library) => ({
      id: `library:${library.skillId}`,
      name: library.slug,
      description: library.description,
      attribution: library.ownerLabel,
      library,
      skill: params.skills.find(
        (skill) => skill.source === "openclaw-library" && skill.name === library.name,
      ),
    }));
  const libraryCommands = new Set(params.libraries.map((entry) => entry.name));
  for (const skill of params.skills) {
    // Library command names are persisted identities, unlike user-facing names/slugs.
    if (skill.source === "openclaw-library" && libraryCommands.has(skill.name)) {
      continue;
    }
    entries.push({
      id: `local:${skill.skillKey}`,
      name: skill.name,
      description: skill.description,
      attribution: installedReference(skill) ?? skill.source,
      skill,
    });
  }
  const remoteIds = new Set<string>();
  for (const remote of params.results) {
    const reference = clawHubSkillRef(remote);
    const identity = `${remote.registry}\n${reference}`;
    if (remoteIds.has(identity)) {
      continue;
    }
    remoteIds.add(identity);
    // A name match is never installation proof. Match the registry and verified publisher/source.
    const installed = entries.find(
      (entry) =>
        entry.skill?.clawhub?.valid &&
        entry.skill.clawhub.registry === remote.registry &&
        installedReference(entry.skill) === reference,
    );
    if (installed) {
      installed.remote = remote;
    } else {
      entries.push({
        id: `remote:${reference}`,
        name: remote.displayName,
        description: remote.summary ?? "",
        attribution: reference,
        remote,
      });
    }
  }
  const query = params.query.trim().toLowerCase();
  // Remote matches retain the registry's semantic ranking, even if their copy lacks the query.
  return entries.filter(
    (entry) =>
      entry.remote ||
      !query ||
      `${entry.name} ${entry.description} ${entry.attribution}`.toLowerCase().includes(query),
  );
}
