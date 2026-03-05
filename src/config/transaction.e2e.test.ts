import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  clearConfigCache,
  readConfigFileSnapshot,
  recoverConfigFromBackups,
  runConfigWriteTransaction,
} from "./config.js";

describe("config transaction e2e", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-transaction-e2e-"));
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

  it("blocks invalid writes at prepare time without touching production config", async () => {
    await withConfigCase({
      raw: '{\n  "gateway": { "mode": "local" }\n}\n',
      run: async (configPath) => {
        const beforeRaw = await fs.readFile(configPath, "utf-8");
        const result = await runConfigWriteTransaction({
          config: {
            gateway: { mode: "not-a-real-mode" as "local" },
          },
        });
        expect(result.ok).toBe(false);
        expect(result.stage).toBe("prepare");
        expect(result.rolledBack).toBe(false);

        const afterRaw = await fs.readFile(configPath, "utf-8");
        expect(afterRaw).toBe(beforeRaw);
      },
    });
  });

  it("restores pre-transaction content after verify failure rollback", async () => {
    await withConfigCase({
      raw: '{\n  "gateway": { "mode": "local" }\n}\n',
      run: async (configPath) => {
        const beforeRaw = await fs.readFile(configPath, "utf-8");
        const result = await runConfigWriteTransaction({
          config: {
            gateway: { mode: "local", bind: "loopback" },
          },
          verifyCommittedSnapshot: () => false,
          verificationErrorMessage: "verify gate rejected commit",
        });
        expect(result.ok).toBe(false);
        expect(result.stage).toBe("verify");
        expect(result.rolledBack).toBe(true);

        const afterRaw = await fs.readFile(configPath, "utf-8");
        expect(afterRaw).toBe(beforeRaw);
      },
    });
  });

  it("skips invalid .bak and recovers from the next valid numbered backup", async () => {
    await withConfigCase({
      raw: "{invalid-json",
      run: async (configPath) => {
        await fs.writeFile(`${configPath}.bak`, "{still-invalid", "utf-8");
        await fs.writeFile(
          `${configPath}.bak.1`,
          '{\n  "gateway": { "mode": "local", "bind": "loopback" }\n}\n',
          "utf-8",
        );

        const result = await recoverConfigFromBackups();
        expect(result.recovered).toBe(true);
        expect(result.sourceBackupPath).toBe(`${configPath}.bak.1`);

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.config.gateway?.bind).toBe("loopback");
      },
    });
  });
});
