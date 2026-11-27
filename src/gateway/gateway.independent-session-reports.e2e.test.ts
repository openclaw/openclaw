import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import {
  expectProofIdle,
  gateway,
  registerProofModelScript,
  waitForProofRun,
} from "./gateway.sessions-send-provenance.test-support.js";

// The HTTP provider scripts tool choices only; creation, sends, turns and history are real.
it("shows independent session reports while keeping supervised coordination private", async () => {
  for (const independent of [false, true]) {
    const marker = `PROVENANCE_SOURCE_report_visibility_${independent}`;
    const parentKey = `agent:main:dashboard:report-visibility-${independent}`;
    const report = `${marker}_UPDATE`;
    const reply = `${marker}_REPLY`;
    let childKey: string | undefined;
    let created = false;
    let sent = false;
    let reportRunId: unknown;
    const requests: unknown[] = [];
    registerProofModelScript(marker, (request) => {
      if (request.tools.length === 0) {
        return { text: "Report visibility" };
      }
      requests.push(request);
      const { prompt, result } = request;
      if (prompt.includes(`${marker}_SEND`)) {
        if (!sent) {
          sent = true;
          return {
            tool: {
              name: "sessions_send",
              args: {
                sessionKey: parentKey,
                message: report,
                timeoutSeconds: 0,
              },
            },
          };
        }
        expect(result).toMatchObject({ status: "accepted" });
        reportRunId = result?.runId;
        return { text: `${marker}_SENT` };
      }
      if (prompt.includes(report)) {
        return { text: reply };
      }
      if (prompt.includes(`${marker}_IDLE`)) {
        return { text: `${marker}_READY` };
      }
      if (!created) {
        created = true;
        return {
          tool: {
            name: independent ? "sessions_create" : "sessions_spawn",
            args: independent
              ? { label: marker }
              : {
                  task: `${marker}_IDLE`,
                  visible: true,
                  label: marker,
                },
          },
        };
      }
      const key = independent ? result?.sessionKey : result?.childSessionKey;
      if (!childKey && typeof key === "string") {
        childKey = key;
      }
      return { text: `${marker}_CREATED` };
    });
    await gateway.client.request("sessions.create", { key: parentKey, agentId: "main" });
    const start = async (sessionKey: string, message: string) => {
      const run = await gateway.client.request<{ runId: string }>("chat.send", {
        sessionKey,
        message,
        idempotencyKey: randomUUID(),
      });
      const outcome = await waitForProofRun(run.runId);
      expect(outcome, JSON.stringify({ message, outcome })).toMatchObject({ status: "ok" });
      await expectProofIdle();
    };
    await start(parentKey, `${marker}_CREATE`);
    expect(childKey, JSON.stringify(requests)).toBeDefined();
    if (!childKey) {
      throw new Error("creation did not return a session key");
    }
    const entry = loadSessionEntry({ agentId: "main", sessionKey: childKey });
    expect(entry).toMatchObject({ spawnedBy: parentKey, spawnDepth: 1 });
    if (independent) {
      await gateway.client.request("sessions.reset", { key: childKey });
      expect(loadSessionEntry({ agentId: "main", sessionKey: childKey })).toMatchObject({
        createdIndependently: true,
        spawnedBy: parentKey,
        spawnDepth: 1,
      });
    }
    await start(childKey, `${marker}_SEND`);
    expect(typeof reportRunId).toBe("string");
    const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
      sessionKey: parentKey,
      limit: 100,
    });
    const messages = history.messages.filter(isRecord);
    const incoming = messages.find(
      (message) =>
        isRecord(message.provenance) &&
        message.provenance.sourceTool === "sessions_send" &&
        JSON.stringify(message.content).includes(report),
    );
    const response = messages.find(
      (message) =>
        message.role === "assistant" &&
        readSessionTranscriptRunId(message) === reportRunId &&
        JSON.stringify(message.content).includes(reply),
    );
    if (independent) {
      expect(incoming).toMatchObject({
        role: "assistant",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: childKey,
          sourceTool: "sessions_send",
        },
      });
      expect(incoming?.display).not.toBe(false);
      expect(response).toBeDefined();
      expect(response?.display).not.toBe(false);
    } else {
      expect(incoming).toBeUndefined();
      expect(response).toBeUndefined();
    }
  }
}, 60_000);

// Real sessions_create and sessions_send turns; only the model's choices are scripted.
it("keeps an independent opening's result obligation while accepting its peer silence", async () => {
  const marker = "PROVENANCE_SOURCE_independent_obligation";
  const parentKey = "agent:main:dashboard:independent-obligation";
  const opening = `${marker}_OPENING`;
  const note = `${marker}_NOTE`;
  const openingPrompts: string[] = [];
  const notePrompts: string[] = [];
  let created: Record<string, unknown> | undefined;
  let sendIssued = false;
  let sent: Record<string, unknown> | undefined;
  registerProofModelScript(marker, (request) => {
    if (request.tools.length === 0) {
      return { text: "Independent obligation" };
    }
    const { prompt, result } = request;
    if (prompt.includes(note)) {
      notePrompts.push(prompt);
      return { text: "NO_REPLY" };
    }
    if (prompt.includes(opening)) {
      openingPrompts.push(prompt);
      return { text: openingPrompts.length === 1 ? "NO_REPLY" : `${marker}_OPENING_RESULT` };
    }
    if (prompt.includes(`${marker}_CREATE`)) {
      if (!result) {
        return {
          tool: { name: "sessions_create", args: { label: marker, message: opening } },
        };
      }
      created = result;
      return { text: `${marker}_CREATED` };
    }
    if (prompt.includes(`${marker}_SEND`)) {
      // The parent's history already ends with the sessions_create output.
      if (!sendIssued) {
        sendIssued = true;
        return {
          tool: {
            name: "sessions_send",
            args: { sessionKey: created?.sessionKey, message: note, timeoutSeconds: 30 },
          },
        };
      }
      sent = result;
      return { text: `${marker}_SENT` };
    }
    throw new Error(`Unexpected independent obligation prompt ${prompt.slice(0, 300)}`);
  });
  await gateway.client.request("sessions.create", { key: parentKey, agentId: "main" });
  const start = async (message: string) => {
    const run = await gateway.client.request<{ runId: string }>("chat.send", {
      sessionKey: parentKey,
      message,
      idempotencyKey: randomUUID(),
    });
    expect(await waitForProofRun(run.runId)).toMatchObject({ status: "ok" });
    await expectProofIdle();
  };

  await start(`${marker}_CREATE`);
  expect(created).toMatchObject({ runStarted: true });
  const childKey = created?.sessionKey;
  if (typeof childKey !== "string" || typeof created?.runId !== "string") {
    throw new Error(`sessions_create did not start a run: ${JSON.stringify(created)}`);
  }
  const openingOutcome = await waitForProofRun(created?.runId);
  await expectProofIdle();
  expect(loadSessionEntry({ agentId: "main", sessionKey: childKey })).toMatchObject({
    createdIndependently: true,
    spawnedBy: parentKey,
    spawnDepth: 1,
  });

  await start(`${marker}_SEND`);
  expect({
    // The opening's NO_REPLY is refused, so the run asks the model again for its result.
    opening: { status: openingOutcome.status, modelCalls: openingPrompts.length },
    // A later message from the creator is a peer message: exact NO_REPLY is accepted once.
    note: { result: sent, modelCalls: notePrompts.length },
  }).toMatchObject({
    opening: { status: "ok", modelCalls: 2 },
    note: { result: { status: "no_reply", sessionKey: childKey }, modelCalls: 1 },
  });
}, 60_000);
