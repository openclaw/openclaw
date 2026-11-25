import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildPreparedModelCatalogSnapshot } from "../agents/model-catalog.js";
import { withInstalledOfficialProviderCustody } from "./provider-policy-custody.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

describe("installed provider policy under Doctor source custody", () => {
  it("prepares the owner before ordering the prepared catalog", async () => {
    const snapshot = await withInstalledOfficialProviderCustody(
      temporary.make("policy-custody-"),
      (metadataSnapshot) =>
        buildPreparedModelCatalogSnapshot({
          agentDir: temporary.make("agent-"),
          authCredentials: {},
          config: {},
          models: [
            { provider: "arcee", id: "arcee-ai/trinity-large-thinking", name: "Trinity" },
            { provider: "arcee", id: "safe-model", name: "Safe" },
          ],
          metadataSnapshot,
          readOnly: true,
        }),
    );

    expect(snapshot.entries.map(({ provider, id }) => `${provider}/${id}`)).toEqual([
      "arcee/arcee-ai/trinity-large-thinking",
      "arcee/safe-model",
    ]);
  });
});
