import type { CronJob } from "../types.js";
import type { CronJobsSortBy, CronSortDir } from "./list-page-types.js";

export function sortCronJobs(
  jobs: CronJob[],
  sortBy: CronJobsSortBy,
  sortDir: CronSortDir,
): CronJob[] {
  const dir = sortDir === "desc" ? -1 : 1;
  // Explicit options bypass native localeCompare caching; keep collation local to this sort.
  let compareNames: Intl.Collator["compare"] | undefined;
  jobs.sort((a, b) => {
    let cmp = 0;
    if (sortBy === "name") {
      compareNames ??= new Intl.Collator(undefined, { sensitivity: "base" }).compare;
      cmp = compareNames(a.name, b.name);
    } else if (sortBy === "updatedAtMs") {
      cmp = a.updatedAtMs - b.updatedAtMs;
    } else {
      const aNext = a.state.nextRunAtMs;
      const bNext = b.state.nextRunAtMs;
      if (aNext !== undefined && bNext !== undefined) {
        cmp = aNext - bNext;
      } else if (aNext !== undefined || bNext !== undefined) {
        // Missing run times stay last in either direction so paused jobs cannot hide scheduled work.
        return aNext !== undefined ? -1 : 1;
      }
    }
    if (cmp !== 0) {
      return cmp * dir;
    }
    // Stable id tiebreaker keeps pagination deterministic when sort keys match.
    return a.id.localeCompare(b.id);
  });
  return jobs;
}
