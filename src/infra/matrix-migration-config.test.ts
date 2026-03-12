import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMatrixMigrationAccountTarget } from "./matrix-migration-config.js";

function writeFile(filePath: string, value: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

describe("resolveMatrixMigrationAccountTarget", () => {
  it("reuses stored user identity for token-only configs when the access token matches", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeFile(
        path.join(stateDir, "credentials", "matrix", "credentials-ops.json"),
        JSON.stringify(
          {
            homeserver: "https://matrix.example.org",
            userId: "@ops-bot:example.org",
            accessToken: "tok-ops",
            deviceId: "DEVICE-OPS",
          },
          null,
          2,
        ),
      );

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                homeserver: "https://matrix.example.org",
                accessToken: "tok-ops",
              },
            },
          },
        },
      };

      const target = resolveMatrixMigrationAccountTarget({
        cfg,
        env: process.env,
        accountId: "ops",
      });

      expect(target).not.toBeNull();
      expect(target?.userId).toBe("@ops-bot:example.org");
      expect(target?.storedDeviceId).toBe("DEVICE-OPS");
    });
  });

  it("ignores stored device IDs from stale cached Matrix credentials", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeFile(
        path.join(stateDir, "credentials", "matrix", "credentials-ops.json"),
        JSON.stringify(
          {
            homeserver: "https://matrix.example.org",
            userId: "@old-bot:example.org",
            accessToken: "tok-old",
            deviceId: "DEVICE-OLD",
          },
          null,
          2,
        ),
      );

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                homeserver: "https://matrix.example.org",
                userId: "@new-bot:example.org",
                accessToken: "tok-new",
              },
            },
          },
        },
      };

      const target = resolveMatrixMigrationAccountTarget({
        cfg,
        env: process.env,
        accountId: "ops",
      });

      expect(target).not.toBeNull();
      expect(target?.userId).toBe("@new-bot:example.org");
      expect(target?.accessToken).toBe("tok-new");
      expect(target?.storedDeviceId).toBeNull();
    });
  });

  it("does not trust stale stored creds on the same homeserver when the token changes", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      writeFile(
        path.join(stateDir, "credentials", "matrix", "credentials-ops.json"),
        JSON.stringify(
          {
            homeserver: "https://matrix.example.org",
            userId: "@old-bot:example.org",
            accessToken: "tok-old",
            deviceId: "DEVICE-OLD",
          },
          null,
          2,
        ),
      );

      const cfg: OpenClawConfig = {
        channels: {
          matrix: {
            accounts: {
              ops: {
                homeserver: "https://matrix.example.org",
                accessToken: "tok-new",
              },
            },
          },
        },
      };

      const target = resolveMatrixMigrationAccountTarget({
        cfg,
        env: process.env,
        accountId: "ops",
      });

      expect(target).toBeNull();
    });
  });
});
