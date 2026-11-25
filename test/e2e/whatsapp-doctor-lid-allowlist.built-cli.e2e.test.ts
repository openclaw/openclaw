import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
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
    const { useMultiFileAuthState } = await vi.importActual<typeof import("baileys")>("baileys");
    const { state } = await useMultiFileAuthState(authDir);
    await state.keys.set({
      "lid-mapping": { "777_reverse": "15551230000", "15551230000": "777" },
    });
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
    const reloaded = await useMultiFileAuthState(authDir);
    expect(await reloaded.state.keys.get("lid-mapping", ["777_reverse"])).toEqual({
      "777_reverse": "15551230000",
    });
    const validation = await instance.cli(["config", "validate"]);
    expect(validation, validation.stdout + validation.stderr).toMatchObject({
      code: 0,
      signal: null,
    });
  } finally {
    await instance.cleanup();
  }
});
