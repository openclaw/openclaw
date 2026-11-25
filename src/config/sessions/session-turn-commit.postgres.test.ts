import { afterEach, describe, vi } from "vitest";
import { withEngineStoreAdmission } from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  runSessionTurnCountTests,
  runSessionTurnPostimageTests,
} from "./session-turn-commit.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL transcript turn commits", () => {
  useMixedAgentPair("postgres", "postgres");
  afterEach(() => vi.restoreAllMocks());
  const harness = {
    engine: "postgres" as const,
    storePath: () => openOpenClawAgentDatabase({ agentId: "main" }).path,
    run: withEngineStoreAdmission,
  };
  runSessionTurnCountTests(harness);
  runSessionTurnPostimageTests(harness);
});
