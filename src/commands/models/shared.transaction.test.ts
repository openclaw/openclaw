import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearConfigCache, readConfigFileSnapshot } from "../../config/config.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { updateConfig } from "./shared.js";

describe("models/shared transactional writes", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-models-shared-transaction-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function withConfigCase<T>(params: {
    raw: string;
    run: (configPath: string) => Promise<T>;
  }): Promise<T> {
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    const configPath = path.join(dir, "openclaw.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(configPath, params.raw, "utf-8");
    return await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_CONFIG_CACHE: "1",
      },
      async () => {
        clearConfigCache();
        return await params.run(configPath);
      },
    );
  }

  it("rejects invalid config mutations and preserves config file state", async () => {
    await withConfigCase({
      raw: '{\n  "gateway": { "mode": "local" }\n}\n',
      run: async (configPath) => {
        const beforeRaw = await fs.readFile(configPath, "utf-8");

        await expect(
          updateConfig((current) => ({
            ...current,
            gateway: { mode: "invalid-mode" as "local" },
          })),
        ).rejects.toThrow("writeConfigFile transaction failed");

        const afterRaw = await fs.readFile(configPath, "utf-8");
        expect(afterRaw).toBe(beforeRaw);

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.config.gateway?.mode).toBe("local");
      },
    });
  });
});
