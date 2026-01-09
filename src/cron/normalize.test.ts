import { describe, expect, it } from "vitest";

import { normalizeCronJobCreate } from "./normalize.js";

describe("normalizeCronJobCreate", () => {
  it("maps legacy payload.channel to payload.provider and strips channel", () => {
    const normalized = normalizeCronJobCreate({
      name: "legacy",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: true,
        channel: "telegram",
        to: "7200373102",
      },
    }) as unknown as Record<string, unknown>;

    const payload = normalized.payload as Record<string, unknown>;
    expect(payload.provider).toBe("telegram");
    expect("channel" in payload).toBe(false);
  });
});
