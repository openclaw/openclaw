import { describe, expect, it } from "vitest";
import { isReplyPayloadTerminalContent } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { createDeliverySuite } from "./agent-runner-delivery-suite.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";

const { createFixture } = createDeliverySuite();

describe.each(["queued", "native"] as const)("%s trace delivery", (lane) => {
  it.each([
    { stored: "off", selected: "raw", authorized: true, trace: true },
    { stored: "raw", selected: "off", authorized: true, trace: false },
    { stored: "raw", selected: undefined, authorized: true, trace: true },
    { stored: "off", selected: "raw", authorized: false, trace: false },
  ] as const)(
    "delivers trace $selected over stored $stored with authority=$authorized",
    async ({ stored, selected, authorized, trace }) => {
      const fixture = await createFixture();
      const storedLevel = lane === "native" && !authorized ? "raw" : stored;
      await fixture.replace({
        ...fixture.context.activeSessionEntry!,
        traceLevel: storedLevel,
        verboseLevel: "off",
      });
      fixture.context.execution.result.meta!.requestShaping = {
        thinking: "medium",
        thinkingClamp: "THINKING_CLAMP_DIAGNOSTIC",
      };
      fixture.context.followupRun.prompt = "QUEUED_INPUT";
      fixture.context.followupRun.run.traceAuthorized = authorized;
      fixture.context.followupRun.run.traceLevelOverride = selected;
      let delivered: ReplyPayload[];
      if (lane === "queued") {
        delivered = await fixture.deliverQueued();
        expect(delivered.some((payload) => payload.text === "done")).toBe(true);
      } else {
        fixture.context.execution.result.payloads = [];
        fixture.context.execution.result.sourceReplyDeliveryState = "delivered";
        fixture.context.execution.result.meta!.finalAssistantRawText = "STREAMED_REPLY";
        fixture.context.sessionCtx.agentText = "STREAMED_INPUT";
        const result = await finalizeReplyAgentRun(fixture.context);
        delivered = Array.isArray(result) ? result : result ? [result] : [];
        expect(delivered.some(isReplyPayloadTerminalContent)).toBe(false);
      }
      const diagnostics = delivered.find((payload) =>
        payload.text?.includes("Model Input (User Role)"),
      );
      expect(Boolean(diagnostics)).toBe(trace);
      if (diagnostics) {
        expect(diagnostics.text).toContain(lane === "queued" ? "QUEUED_INPUT" : "STREAMED_INPUT");
        if (lane === "native") {
          expect(diagnostics.text).toContain("STREAMED_REPLY");
        }
        expect(isReplyPayloadTerminalContent(diagnostics)).toBe(false);
      }
      expect(delivered.some((payload) => payload.text?.includes("THINKING_CLAMP_DIAGNOSTIC"))).toBe(
        trace,
      );
      expect(fixture.read()?.traceLevel).toBe(storedLevel);
    },
  );
});

describe.each(["ordinary", "followup"] as const)("%s completion verbosity", (lane) => {
  it.each([
    { initial: "on", live: "off", override: "on", visible: true },
    { initial: "off", live: "on", override: "off", visible: false },
  ] as const)(
    "uses live $live after $initial unless the turn selects $override",
    async ({ initial, live, override, visible }) => {
      const fixture = await createFixture();
      const entry = fixture.context.activeSessionEntry!;
      entry.verboseLevel = initial;
      fixture.context.resolvedVerboseLevel = override ?? initial;
      fixture.context.followupRun.run.verboseLevel = override ?? initial;
      fixture.context.followupRun.run.verboseLevelOverride = override;
      fixture.context.followupRun.run.traceAuthorized = false;
      fixture.context.execution.result.meta!.requestShaping = {
        thinking: "medium",
        thinkingClamp: "THINKING_CLAMP_DIAGNOSTIC",
      };
      await fixture.replace({
        ...entry,
        verboseLevel: live,
        pluginDebugEntries: [{ pluginId: "synthetic", lines: ["LIVE_VERBOSE_STATUS"] }],
      });
      const result =
        lane === "ordinary"
          ? await finalizeReplyAgentRun(fixture.context)
          : await fixture.deliverQueued();
      const text = (Array.isArray(result) ? result : [result])
        .map((payload) => payload?.text)
        .join("\n");
      expect(text).toContain("done");
      expect(text.includes("LIVE_VERBOSE_STATUS")).toBe(visible);
      expect(text.includes("THINKING_CLAMP_DIAGNOSTIC")).toBe(visible);
      expect(fixture.read()?.verboseLevel).toBe(live);
    },
  );
});
