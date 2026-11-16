// Cron tests do not read the free memory of the machine running them: a loaded test host would
// otherwise hold automation to one run at a time. Cases about the memory gate set their own
// readings with stubFreeMemory.
import { beforeEach } from "vitest";
import { stubFreeMemory } from "./free-memory.js";

beforeEach(() => {
  stubFreeMemory(Number.MAX_SAFE_INTEGER);
});
