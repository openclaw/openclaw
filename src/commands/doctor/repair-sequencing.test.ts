import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { runDoctorRepairSequence } from "./repair-sequencing.js";

describe("doctor repair sequencing", () => {
  it("applies ordered repairs and sanitizes empty-allowlist warnings", async () => {
    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          channels: {
            discord: {
              allowFrom: [123],
            },
            tools: {
              exec: {
                toolsBySender: {
                  "bad\u001B[31m-key\u001B[0m\r\nnext": { enabled: true },
                },
              },
            },
            signal: {
              accounts: {
                "ops\u001B[31m-team\u001B[0m\r\nnext": {
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        } as unknown as OpenClawConfig,
        candidate: {
          channels: {
            discord: {
              allowFrom: [123],
            },
            tools: {
              exec: {
                toolsBySender: {
                  "bad\u001B[31m-key\u001B[0m\r\nnext": { enabled: true },
                },
              },
            },
            signal: {
              accounts: {
                "ops\u001B[31m-team\u001B[0m\r\nnext": {
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.candidate.channels?.discord?.allowFrom).toEqual([123]);
    expect(result.changeNotes).toEqual([
      expect.stringContaining(
        "channels.tools.exec.toolsBySender: migrated 1 legacy key to typed id: entries",
      ),
    ]);
    expect(result.changeNotes[0]).toContain("bad-keynext -> id:bad-keynext");
    expect(result.changeNotes[0]).not.toContain("\u001B");
    expect(result.changeNotes[0]).not.toContain("\r");
    expect(result.warningNotes).toEqual([
      expect.stringContaining("channels.signal.accounts.ops-teamnext.dmPolicy"),
    ]);
    expect(result.warningNotes[0]).not.toContain("\u001B");
    expect(result.warningNotes[0]).not.toContain("\r");
  });

  it("emits Discord warnings when unsafe numeric ids block repair", async () => {
    const result = await runDoctorRepairSequence({
      state: {
        cfg: {
          channels: {
            discord: {
              allowFrom: [106232522769186816],
            },
          },
        } as unknown as OpenClawConfig,
        candidate: {
          channels: {
            discord: {
              allowFrom: [106232522769186816],
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.changeNotes).toEqual([]);
    expect(result.warningNotes).toEqual([]);
    expect(result.state.pendingChanges).toBe(false);
    expect(result.state.candidate.channels?.discord?.allowFrom).toEqual([106232522769186816]);
  });
});
