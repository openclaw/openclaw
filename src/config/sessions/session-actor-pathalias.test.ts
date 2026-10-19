import path from "node:path";
import { it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import {
  assertSessionActorPathAliasReuse,
  createAliasedSessionStateRoot,
} from "./session-actor-pathalias.test-support.js";

it("reuses the actor through admitted SQLite path aliases without crossing database identities", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: false },
    async (state) => {
      const alias = await createAliasedSessionStateRoot(state.root, state.stateDir);
      const aliases = {
        OPENCLAW_STATE_DIR: alias,
        OPENCLAW_CONFIG_PATH: path.join(alias, "openclaw.json"),
      };
      Object.assign(state.envVars, aliases);
      Object.assign(state.env, aliases);
      state.applyEnv();
      await captureRuntimeConfigAsyncReader()();
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      await assertSessionActorPathAliasReuse(
        database,
        openOpenClawAgentDatabase({
          agentId: "main",
          path: path.join(path.dirname(database.path), "other.sqlite"),
        }),
        state.env,
      );
    },
  );
});
