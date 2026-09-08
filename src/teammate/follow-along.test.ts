import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendFollowAlongEvent,
  compileFollowAlongSkill,
  createFollowAlongTrace,
  FOLLOW_ALONG_SUCCESS_THRESHOLD,
  persistFollowAlongTrace,
  recordFollowAlongSkillSuccess,
  shouldOfferWeekdayJob,
} from "./follow-along.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("follow-along recorder", () => {
  it("compiles a live path into a skill with approvals and offer after two successes", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-follow-along-"));
    tempDirs.push(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir };

    let trace = createFollowAlongTrace({ agentId: "researcher", sessionKey: "agent:researcher:main" });
    trace = appendFollowAlongEvent(trace, { kind: "app", summary: "Admin UI", app: "chrome" });
    trace = appendFollowAlongEvent(trace, { kind: "url", summary: "https://admin.example/signups" });
    trace = appendFollowAlongEvent(trace, {
      kind: "decision",
      summary: "Export this week's signups without using the API",
    });
    trace = appendFollowAlongEvent(trace, {
      kind: "approval",
      summary: "Do not send the customer email",
    });
    persistFollowAlongTrace(trace, env);
    const skill = compileFollowAlongSkill(trace, "weekly-signups");
    expect(skill.markdown).toContain("## When to use");
    expect(skill.markdown).toContain("## Approvals");
    expect(skill.approvals).toContain("Do not send");

    const first = recordFollowAlongSkillSuccess({
      agentId: "researcher",
      sessionKey: trace.sessionKey,
      skillName: skill.name,
      traceId: trace.id,
      env,
    });
    expect(shouldOfferWeekdayJob(first)).toBe(false);
    const second = recordFollowAlongSkillSuccess({
      agentId: "researcher",
      sessionKey: trace.sessionKey,
      skillName: skill.name,
      traceId: trace.id,
      env,
    });
    expect(second.successCount).toBe(FOLLOW_ALONG_SUCCESS_THRESHOLD);
    expect(shouldOfferWeekdayJob(second)).toBe(true);
    expect(second.weekdayOffer?.expr).toBe("0 8 * * 1-5");
  });
});
