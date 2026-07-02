import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("discord visible reply monitor systemd templates", () => {
  it("ships a oneshot service template for the monitor script", () => {
    const source = fs.readFileSync(
      "scripts/systemd/openclaw-discord-visible-reply-monitor.service",
      "utf8",
    );
    expect(source).toContain("Description=OpenClaw Discord Visible Reply Monitor");
    expect(source).toContain("ExecStart=@OPENCLAW_DISCORD_VISIBLE_REPLY_MONITOR_PATH@");
    expect(source).toContain("OPENCLAW_VISIBLE_REPLY_CHANNEL");
    expect(source).toContain("OPENCLAW_VISIBLE_REPLY_ALERT_TARGET");
  });

  it("ships a repeating timer template for the monitor", () => {
    const source = fs.readFileSync(
      "scripts/systemd/openclaw-discord-visible-reply-monitor.timer",
      "utf8",
    );
    expect(source).toContain("Description=Check Discord visible replies every 2 minutes");
    expect(source).toContain("OnBootSec=2min");
    expect(source).toContain("OnUnitActiveSec=2min");
    expect(source).toContain("Persistent=true");
  });
});
