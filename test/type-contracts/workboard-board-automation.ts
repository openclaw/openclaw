import { expectTypeOf } from "vitest";
import type {
  WorkboardBoardMetadata,
  WorkboardBoardSummary,
} from "../../packages/workboard-contract/src/index.js";

// workboard board automation contract
// carries the owning automation job reference in metadata and summaries
const metadata: WorkboardBoardMetadata = {
  id: "planning",
  automationJobId: "job-categorize-planning",
  createdAt: 1,
  updatedAt: 1,
};
const summary: WorkboardBoardSummary = {
  id: metadata.id,
  automationJobId: metadata.automationJobId,
  total: 0,
  active: 0,
  archived: 0,
  byStatus: {},
};

expectTypeOf(summary.automationJobId).toEqualTypeOf<string | undefined>();
