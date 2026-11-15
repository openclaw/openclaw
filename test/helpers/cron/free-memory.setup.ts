// Run slots in cron tests come from the agent limit, not the free memory of the machine running
// them: a loaded test host would otherwise admit fewer runs than a case needs at once. Cases about
// memory admission set their own readings with stubFreeMemory.
import { beforeEach } from "vitest";
import { stubFreeMemory } from "./free-memory.js";

beforeEach(() => {
  stubFreeMemory(Number.MAX_SAFE_INTEGER);
});
