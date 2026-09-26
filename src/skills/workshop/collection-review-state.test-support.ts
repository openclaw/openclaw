import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { readSkillCuratorReviewStatusInDatabase } from "./collection-review.kernel.js";

export function readSkillCuratorReviewStatus(options: OpenClawStateDatabaseOptions = {}) {
  return readSkillCuratorReviewStatusInDatabase(openOpenClawStateDatabase(options));
}
