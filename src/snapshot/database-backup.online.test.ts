import { expect, it, vi } from "vitest";
import { useLocalStateOwnerFixture } from "../cli/local-state-owner.fixture.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import { getScopedDatabaseEngineSelection } from "../infra/database-engine/context.js";
import * as stateOwner from "../infra/gateway-state-owner.js";
import { runOfflineDatabaseBackup } from "./database-backup.js";

const fixture = useLocalStateOwnerFixture();

it("captures archive databases beside a running Gateway while other captures stay offline-only", async () => {
  await fixture.startOwner();
  // The fixture owner shares this process; the CLI under test holds no hosted Gateway root.
  vi.spyOn(stateOwner, "hasActiveGatewayStateOwner").mockReturnValue(false);
  const config: OpenClawConfig = {
    database: { engine: "postgres", postgres: { connection: "postgresql://127.0.0.1:1/unused" } },
  };
  const selection = await resolveDatabaseEngineSelection(config);
  const captured = await runOfflineDatabaseBackup(
    "archive",
    async () => {
      expect(getScopedDatabaseEngineSelection()).toBe(selection);
      // Store captures inside the archive join its scope instead of asking for custody again.
      return runOfflineDatabaseBackup("store", async (store) => store.config);
    },
    { config, selection },
    { online: true },
  );
  expect(captured).toBe(config);
  await expect(
    runOfflineDatabaseBackup("store", async () => {}, { config, selection }),
  ).rejects.toThrow("This command is offline-only");
  expect(fixture.transport.request).not.toHaveBeenCalled();
});
