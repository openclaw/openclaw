import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { openBaileysLidMapping } from "../helpers/baileys-lid-mapping.test-support.js";
import { createOpenClawTestInstance } from "../helpers/openclaw-test-instance.js";

it("migrates persisted LID policies through Doctor without changing stored identities", async () => {
  const instance = await createOpenClawTestInstance({
    name: "whatsapp-doctor-lid-allowlist",
    state: { scenario: "external-service" },
    config: {
      gateway: { mode: "local" },
      plugins: { allow: ["whatsapp"], entries: { whatsapp: { enabled: true } } },
      channels: {
        whatsapp: {
          defaultAccount: "work",
          accounts: {
            work: {
              dmPolicy: "allowlist",
              allowFrom: ["777:2@hosted.lid", "+15551230001"],
              groupAllowFrom: ["777@lid"],
            },
          },
        },
      },
    },
  });
  try {
    const authDir = path.join(instance.stateDir, "credentials", "whatsapp", "work");
    const mappings = await openBaileysLidMapping(authDir);
    await mappings.storeLIDPNMappings([{ lid: "777@lid", pn: "15551230000@s.whatsapp.net" }]);
    const reversePath = path.join(authDir, "lid-mapping-777_reverse.json");
    const storedMapping = await fs.readFile(reversePath, "utf8");
    const result = await instance.cli([
      "doctor",
      "--fix",
      "--non-interactive",
      "--no-workspace-suggestions",
    ]);
    expect(result, result.stdout + result.stderr).toMatchObject({ code: 0, signal: null });
    const config: unknown = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
    expect(config).toMatchObject({
      channels: {
        whatsapp: {
          accounts: {
            work: {
              allowFrom: ["15551230000", "+15551230001"],
              groupAllowFrom: ["15551230000"],
            },
          },
        },
      },
    });
    expect(await fs.readFile(reversePath, "utf8")).toBe(storedMapping);
    const reloadedMappings = await openBaileysLidMapping(authDir);
    expect(await reloadedMappings.getPNForLID("777@lid")).toContain("15551230000:");
    const validation = await instance.cli(["config", "validate"]);
    expect(validation, validation.stdout + validation.stderr).toMatchObject({
      code: 0,
      signal: null,
    });
  } finally {
    await instance.cleanup();
  }
});
