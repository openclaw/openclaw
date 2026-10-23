import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StateDatabaseDiscovery } from "../../infra/update-candidate-paths.js";
import { resolveGatewayRecoverySchemaPaths } from "./update-command-service-recovery.js";

describe("migrated Gateway recovery schema ownership", () => {
  it("excludes plugin databases while retaining discovered agent databases", () => {
    const stateDir = path.resolve("test-fixtures", "recovery-state");
    const agentPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    const pluginPath = path.join(stateDir, "plugins", "workboard", "workboard.sqlite");
    const inventory = new Map<string, StateDatabaseDiscovery>([
      [
        agentPath,
        {
          spellings: [agentPath],
          owners: [{ role: "agent", agentId: "main" }],
        },
      ],
      [pluginPath, { spellings: [pluginPath] }],
    ]);

    const paths = resolveGatewayRecoverySchemaPaths({ OPENCLAW_STATE_DIR: stateDir }, inventory);

    expect(paths).toContain(agentPath);
    expect(paths).toContain(
      path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    expect(paths).not.toContain(pluginPath);
  });
});
