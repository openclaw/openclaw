import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi, PluginHookHandlerMap } from "../../types.js";
import {
  createSreIncidentFormatPlugin,
  isProgressOnlyChatter,
  isProgressOnlyMessage,
  sanitizeIncidentMessage,
  shouldBlockIncidentMessage,
} from "./index.js";

describe("shouldBlockIncidentMessage", () => {
  it("blocks obvious progress-only chatter", () => {
    expect(shouldBlockIncidentMessage("Now let me write the fixed file.")).toBe(true);
    expect(shouldBlockIncidentMessage("Let me check the conventions.")).toBe(true);
    expect(shouldBlockIncidentMessage("Found it.")).toBe(true);
    expect(shouldBlockIncidentMessage("On it")).toBe(true);
    expect(shouldBlockIncidentMessage("The code looks correct here.")).toBe(true);
    expect(shouldBlockIncidentMessage("Good — I found the failing query.")).toBe(true);
    expect(shouldBlockIncidentMessage("*Status:* checking logs")).toBe(true);
    expect(shouldBlockIncidentMessage("*Status:*")).toBe(true);
    expect(shouldBlockIncidentMessage("-")).toBe(true);
    expect(shouldBlockIncidentMessage("- Checking logs now")).toBe(true);
  });

  it("allows incident-format summaries", () => {
    const reply = `*Incident:* Server crash
*Customer impact:* confirmed
*Status:* investigating
*Evidence:* Pod restarted 3 times`;
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("allows free-form summaries without incident labels", () => {
    const reply = `Root cause is Redis key growth in market history snapshots.
No confirmed customer impact so far.
Next step is shortening the cache TTL and watching memory flatten over the next hour.`;
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("allows substantive long free-form summaries", () => {
    expect(
      shouldBlockIncidentMessage(
        "Now I have the complete picture. The totalRealAssets in AdaptersProvider is computed as " +
          "x".repeat(300),
      ),
    ).toBe(false);
  });

  it("keeps substantive one-line summaries that start with previously broad prefixes", () => {
    expect(shouldBlockIncidentMessage("The script failed because Redis exhausted memory.")).toBe(
      false,
    );
    expect(shouldBlockIncidentMessage("Checking logs showed Redis key growth.")).toBe(false);
    expect(shouldBlockIncidentMessage("Good - mitigation is deployed.")).toBe(false);
    expect(shouldBlockIncidentMessage("Ok - we deployed mitigation.")).toBe(false);
    expect(shouldBlockIncidentMessage("Wait - this was caused by stale cache churn.")).toBe(false);
  });

  it("allows a single-line non-progress summary", () => {
    expect(shouldBlockIncidentMessage("The root cause is memory leak.")).toBe(false);
  });

  it("allows critical error summaries", () => {
    expect(
      shouldBlockIncidentMessage("ERROR: repayment failures came from Permit2 allowance drift."),
    ).toBe(false);
    expect(
      shouldBlockIncidentMessage("Failure confirmed in production; the deploy broke quote sync."),
    ).toBe(false);
  });

  it("allows labeled evidence lines that start with procedural phrasing", () => {
    expect(
      shouldBlockIncidentMessage(
        "*Evidence:* I need to verify the pod crash log timestamp matches the alert window.",
      ),
    ).toBe(false);
    expect(shouldBlockIncidentMessage("*Evidence:* I need to check the pod logs.")).toBe(false);
  });

  it("allows summaries that omit the old required evidence label", () => {
    const reply = `[[reply_to_current]] <@U07KE3NALTX>
*Incident:* Redis memory pressure
*Customer impact:* No confirmed customer impact
*Status:* Investigated
*Key facts:* Top memory consumers are market-history snapshots and avg-apy keys`;
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("trims leading progress chatter before a later structured summary", () => {
    const reply = `Wait — I just noticed something important.

Now I'm going to stop and write the definitive response.

[[heartbeat_to:#platform-monitoring]]
<@U07KE3NALTX>
*Incident:* API latency spike
*Customer impact:* confirmed`;
    expect(sanitizeIncidentMessage(reply)).toBe(`[[heartbeat_to:#platform-monitoring]]
<@U07KE3NALTX>
*Incident:* API latency spike
*Customer impact:* confirmed`);
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("allows multiple Slack mention tokens before the incident header", () => {
    const reply = `<@U07KE3NALTX> <!subteam^S123|platform-oncall>
*Incident:* API latency spike
*Customer impact:* confirmed
*Status:* investigating
*Evidence:* p95 latency crossed threshold`;
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("trims non-summary angle-bracket tokens before the incident header", () => {
    const reply = `<https://example.com|runbook>
*Incident:* API latency spike
*Customer impact:* confirmed`;
    expect(sanitizeIncidentMessage(reply)).toBe(`*Incident:* API latency spike
*Customer impact:* confirmed`);
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("allows summary labels beyond just the incident label", () => {
    expect(shouldBlockIncidentMessage("*Evidence:* one fact")).toBe(false);
    expect(shouldBlockIncidentMessage("*Mitigation:* restart pod")).toBe(false);
    expect(shouldBlockIncidentMessage("*Likely cause:* memory leak")).toBe(false);
    expect(shouldBlockIncidentMessage("*Status:* resolved")).toBe(false);
  });

  it("preserves blank spacing between routing prefixes and substantive content", () => {
    const reply = `[[heartbeat_to:#platform-monitoring]]

*Incident:* API latency spike`;
    expect(sanitizeIncidentMessage(reply)).toBe(reply);
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("trims leading progress chatter before a later free-form summary", () => {
    const reply = `Checking logs now.

Let me verify one last thing.

Root cause is Redis key growth in market-history snapshots.
No confirmed customer impact so far.`;
    expect(sanitizeIncidentMessage(reply))
      .toBe(`Root cause is Redis key growth in market-history snapshots.
No confirmed customer impact so far.`);
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("blocks empty messages", () => {
    expect(shouldBlockIncidentMessage("")).toBe(true);
    expect(shouldBlockIncidentMessage("   ")).toBe(true);
  });

  it("collapses all-progress chatter to an empty trimmed payload", () => {
    const reply = `[[heartbeat_to:#platform-monitoring]]

Checking logs now.
Let me verify one last thing.`;
    expect(sanitizeIncidentMessage(reply)).toBe("[[heartbeat_to:#platform-monitoring]]");
    expect(shouldBlockIncidentMessage(reply)).toBe(true);
  });

  it("treats plain summaries separately from progress-only narration", () => {
    const reply = `Root cause is stale cache churn from market-history keys.
Mitigation is lowering TTL and watching allocator fragmentation drop.`;
    expect(isProgressOnlyChatter(reply)).toBe(false);
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("treats partial incident summaries as non-progress replies", () => {
    const reply = `*Incident:* API latency spike
*Customer impact:* confirmed`;
    expect(isProgressOnlyMessage(reply)).toBe(false);
    expect(shouldBlockIncidentMessage(reply)).toBe(false);
  });

  it("rewrites outgoing incident-thread content through the plugin hook", async () => {
    const handlers = new Map<string, PluginHookHandlerMap[keyof PluginHookHandlerMap]>();
    const api = {
      config: {},
      pluginConfig: {},
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      on(hookName: string, handler: PluginHookHandlerMap[keyof PluginHookHandlerMap]) {
        handlers.set(hookName, handler);
      },
    } as unknown as OpenClawPluginApi;

    await createSreIncidentFormatPlugin().register?.(api);
    const handler = handlers.get("message_sending") as PluginHookHandlerMap["message_sending"];
    const result = await handler(
      {
        to: "channel:C07G53ZCV5K",
        content: "Checking logs now.\n\nThe root cause is memory leak.",
        metadata: { channelId: "C07G53ZCV5K" },
      },
      { channelId: "slack" },
    );

    expect(result).toEqual({ content: "The root cause is memory leak." });
  });

  it("allows first-person procedural phrasing when the line is substantive", () => {
    expect(shouldBlockIncidentMessage("I'm checking the logs because of memory pressure.")).toBe(
      false,
    );
  });
});
