import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { drainSessionStoreWriterQueuesForTest } from "../../config/sessions/store-writer-state.test-support.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db-disposal.js";
import {
  closeOpenClawAgentDatabasesAsync,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { isReplyPayloadTerminalContent } from "../reply-payload.js";
import { createAgentAccountingPersistenceFixture } from "./agent-runner-result-accounting.persistence.test-support.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const operations: ReplyOperation[] = [];
let suiteRoot: string;
let storePath: string;
let fixtureSequence = 0;
beforeAll(() => {
  // openclaw-temp-dir: allow suite database root drains before removal
  suiteRoot = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), "openclaw-accounting-suite-"),
  );
  storePath = path.join(suiteRoot, "openclaw-agent.sqlite");
  openOpenClawAgentDatabase({ agentId: "main", path: storePath });
});
afterAll(async () => {
  await drainSessionStoreWriterQueuesForTest();
  await disposeOpenClawAgentDatabaseByPath(storePath);
  await closeOpenClawAgentDatabasesAsync(suiteRoot);
  expect(isOpenClawAgentDatabaseOpen(storePath)).toBe(false);
  fs.rmSync(suiteRoot, { recursive: true, force: true });
});
afterEach(() => {
  for (const operation of operations.splice(0)) {
    operation.complete();
  }
});
function createFixture() {
  return createAgentAccountingPersistenceFixture({
    storePath,
    root: tempDirs.make("openclaw-context-pressure-"),
    fixtureId: ++fixtureSequence,
    registerOperation: (operation) => {
      operations.push(operation);
    },
  });
}

it.each([
  { stored: "off", selected: "raw", authorized: true, trace: true },
  { stored: "raw", selected: "off", authorized: true, trace: false },
  { stored: "raw", selected: undefined, authorized: true, trace: true },
  { stored: "off", selected: "raw", authorized: false, trace: false },
] as const)(
  "delivers queued trace $selected over stored $stored with authority=$authorized",
  async ({ stored, selected, authorized, trace }) => {
    const fixture = await createFixture();
    await fixture.replace({
      ...fixture.context.activeSessionEntry!,
      traceLevel: stored,
      verboseLevel: "off",
    });
    fixture.context.execution.result.meta!.requestShaping = {
      thinking: "medium",
      thinkingClamp: "THINKING_CLAMP_DIAGNOSTIC",
    };
    fixture.context.followupRun.prompt = "QUEUED_INPUT";
    fixture.context.followupRun.run.traceAuthorized = authorized;
    fixture.context.followupRun.run.traceLevelOverride = selected;
    const delivered = await fixture.deliverQueued();
    expect(delivered.some((payload) => payload.text === "done")).toBe(true);
    const diagnostics = delivered.find((payload) =>
      payload.text?.includes("Model Input (User Role)"),
    );
    expect(Boolean(diagnostics)).toBe(trace);
    if (diagnostics) {
      expect(diagnostics.text).toContain("QUEUED_INPUT");
      expect(isReplyPayloadTerminalContent(diagnostics)).toBe(false);
    }
    expect(delivered.some((payload) => payload.text?.includes("THINKING_CLAMP_DIAGNOSTIC"))).toBe(
      trace,
    );
    expect(fixture.read()?.traceLevel).toBe(stored);
  },
);

it.each([
  { stored: "off", selected: "raw", authorized: true, trace: true },
  { stored: "raw", selected: "off", authorized: true, trace: false },
  { stored: "raw", selected: undefined, authorized: true, trace: true },
  { stored: "raw", selected: "raw", authorized: false, trace: false },
] as const)(
  "retains trace $selected over stored $stored after native delivery with authority=$authorized",
  async ({ stored, selected, authorized, trace }) => {
    const fixture = await createFixture();
    await fixture.replace({
      ...fixture.context.activeSessionEntry!,
      traceLevel: stored,
      verboseLevel: "off",
    });
    fixture.context.followupRun.run.traceAuthorized = authorized;
    fixture.context.followupRun.run.traceLevelOverride = selected;
    fixture.context.execution.result.payloads = [];
    fixture.context.execution.result.sourceReplyDeliveryState = "delivered";
    fixture.context.execution.result.meta!.requestShaping = {
      thinking: "medium",
      thinkingClamp: "THINKING_CLAMP_DIAGNOSTIC",
    };
    fixture.context.execution.result.meta!.finalAssistantRawText = "STREAMED_REPLY";
    fixture.context.sessionCtx.agentText = "STREAMED_INPUT";

    const result = await finalizeReplyAgentRun(fixture.context);
    const delivered = Array.isArray(result) ? result : result ? [result] : [];
    expect(delivered.some((payload) => isReplyPayloadTerminalContent(payload))).toBe(false);
    const diagnostics = delivered.find((payload) =>
      payload.text?.includes("Model Input (User Role)"),
    );
    expect(Boolean(diagnostics)).toBe(trace);
    if (diagnostics) {
      expect(diagnostics.text).toContain("STREAMED_INPUT");
      expect(diagnostics.text).toContain("STREAMED_REPLY");
    }
    expect(delivered.some((payload) => payload.text?.includes("THINKING_CLAMP_DIAGNOSTIC"))).toBe(
      trace,
    );
    expect(fixture.read()?.traceLevel).toBe(stored);
  },
);

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
