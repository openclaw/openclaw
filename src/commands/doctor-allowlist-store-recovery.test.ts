import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";
import { maybeRepairAllowlistPolicyAllowFrom } from "./doctor-allowlist-store-recovery.js";

describe("doctor allowlist store recovery", () => {
  it("restores top-level allowFrom from pairing store for top-only channels", async () => {
    const result = await withTempHome(async (home) => {
      const credentialsDir = path.join(home, ".openclaw", "credentials");
      await fs.mkdir(credentialsDir, { recursive: true });
      await fs.writeFile(
        path.join(credentialsDir, "telegram-default-allowFrom.json"),
        JSON.stringify({ version: 1, allowFrom: ["12345"] }, null, 2),
        "utf-8",
      );

      return await maybeRepairAllowlistPolicyAllowFrom({
        channels: {
          telegram: {
            dmPolicy: "allowlist",
          },
        },
      } as unknown as OpenClawConfig);
    });

    expect(result.changes).toEqual([
      '- channels.telegram.allowFrom: restored 1 sender entry from pairing store (dmPolicy="allowlist").',
    ]);
    expect(result.config).toEqual({
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          allowFrom: ["12345"],
        },
      },
    });
  });

  it("restores nested dm.allowFrom for nested-only channels", async () => {
    const result = await withTempHome(async (home) => {
      const credentialsDir = path.join(home, ".openclaw", "credentials");
      await fs.mkdir(credentialsDir, { recursive: true });
      await fs.writeFile(
        path.join(credentialsDir, "googlechat-default-allowFrom.json"),
        JSON.stringify({ version: 1, allowFrom: ["users/123"] }, null, 2),
        "utf-8",
      );

      return await maybeRepairAllowlistPolicyAllowFrom({
        channels: {
          googlechat: {
            dm: {
              policy: "allowlist",
            },
          },
        },
      } as unknown as OpenClawConfig);
    });

    expect(result.changes).toEqual([
      '- channels.googlechat.dm.allowFrom: restored 1 sender entry from pairing store (dmPolicy="allowlist").',
    ]);
    expect(result.config).toEqual({
      channels: {
        googlechat: {
          dm: {
            policy: "allowlist",
            allowFrom: ["users/123"],
          },
        },
      },
    });
  });

  it("restores nested dm.allowFrom for top-or-nested account scopes when dm already exists", async () => {
    const result = await withTempHome(async (home) => {
      const credentialsDir = path.join(home, ".openclaw", "credentials");
      await fs.mkdir(credentialsDir, { recursive: true });
      await fs.writeFile(
        path.join(credentialsDir, "discord-work-allowFrom.json"),
        JSON.stringify({ version: 1, allowFrom: ["111", "111", " 222 "] }, null, 2),
        "utf-8",
      );

      return await maybeRepairAllowlistPolicyAllowFrom({
        channels: {
          discord: {
            accounts: {
              work: {
                dm: {
                  policy: "allowlist",
                  allowFrom: [],
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig);
    });

    expect(result.changes).toEqual([
      '- channels.discord.accounts.work.dm.allowFrom: restored 2 sender entries from pairing store (dmPolicy="allowlist").',
    ]);
    expect(result.config).toEqual({
      channels: {
        discord: {
          accounts: {
            work: {
              dm: {
                policy: "allowlist",
                allowFrom: ["111", "222"],
              },
            },
          },
        },
      },
    });
  });

  it("returns the original config when allowFrom is already populated", async () => {
    const cfg = {
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          allowFrom: ["12345"],
        },
      },
    } as unknown as OpenClawConfig;

    const result = await withTempHome(async () => await maybeRepairAllowlistPolicyAllowFrom(cfg));

    expect(result).toEqual({ config: cfg, changes: [] });
  });
});
