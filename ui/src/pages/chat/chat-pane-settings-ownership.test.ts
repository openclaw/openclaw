/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { withSessionMutationOperations } from "../../lib/sessions/session-mutation-operations.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { createMountedPanes } from "./chat-pane-mounted.test-support.ts";
import { mountSettings, settingsAck, settingsRow } from "./chat-pane-settings.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each([
  { outcome: "rejected", field: "thinking" },
  { outcome: "older-clock ACK", field: "thinking" },
  { outcome: "rejected", field: "access program" },
  { outcome: "older-clock ACK", field: "access program" },
] as const)(
  "retains settled $field facts after an older direct capability patch returns $outcome",
  async ({ outcome, field }) => {
    const initial = settingsRow("settings-ownership", {
      label: "Original label",
      fastMode: false,
      effectiveFastMode: false,
      contextWindow: "64k",
    });
    const firstFields =
      field === "thinking"
        ? { thinkingLevel: "off" }
        : { cyberAccessProgram: "daybreak_blue" as const };
    const secondFields =
      field === "thinking" ? { thinkingLevel: "low" } : { cyberAccessProgram: "standard" as const };
    const firstReply = createDeferred<unknown>();
    const secondReply = createDeferred<unknown>();
    const firstAcknowledgement = settingsAck(initial, { updatedAt: 2, ...firstFields });
    const secondAcknowledgement = settingsAck(initial, { updatedAt: 3, ...secondFields });
    let calls = 0;
    const patch = vi.fn<GatewayRequestHandler>(() => {
      calls += 1;
      if (calls === 1) {
        return firstReply.promise;
      }
      expect(calls).toBe(2);
      return secondReply.promise;
    });
    const fixture = createMountedPanes([initial], "main", undefined, {
      "sessions.patch": patch,
    });
    const { sessions } = fixture;
    let first: ReturnType<typeof sessions.patch> | undefined;
    let second: ReturnType<typeof sessions.patch> | undefined;
    let firstSettled = false;
    try {
      const { assertRows } = await mountSettings(fixture, initial);
      const assertFields = (fields: Partial<GatewaySessionRow>) =>
        assertRows({ key: initial.key, sessionId: initial.sessionId, ...fields });
      assertFields(initial);
      const options = {
        agentId: "main",
        expectedSessionId: initial.sessionId,
        deferListRefresh: true,
      };
      // Direct capability callers can overlap; chat pickers serialize their RPCs separately.
      first = sessions.patch(initial.key, firstFields, options);
      const firstOutcome = Promise.allSettled([first]).then((results) => {
        firstSettled = true;
        return results;
      });
      assertFields(firstFields);
      second = sessions.patch(initial.key, secondFields, options);
      assertFields(secondFields);
      await withSessionMutationOperations(() => undefined);
      expect(patch).toHaveBeenCalledTimes(2);

      secondReply.resolve(secondAcknowledgement);
      await expect(second).resolves.toMatchObject(secondAcknowledgement);
      expect(firstSettled).toBe(false);
      assertFields(secondFields);

      const rejection = new Error("Synthetic late rejection after successor settled");
      if (outcome === "rejected") {
        firstReply.reject(rejection);
      } else {
        firstReply.resolve(firstAcknowledgement);
      }
      const [settled] = await firstOutcome;
      if (outcome === "rejected") {
        expect(settled).toEqual({ status: "rejected", reason: rejection });
      } else {
        expect(settled).toMatchObject({ status: "fulfilled", value: firstAcknowledgement });
      }
      assertFields(secondFields);
      expect(patch).toHaveBeenCalledTimes(2);
    } finally {
      firstReply.resolve(firstAcknowledgement);
      secondReply.resolve(secondAcknowledgement);
      await Promise.allSettled([first, second]);
      await vi.dynamicImportSettled();
    }
  },
);

it.each([
  { read: "deferred", overlap: false, observeEffective: false },
  { read: "failed", overlap: false, observeEffective: false },
  { read: "deferred", overlap: true, observeEffective: false },
  { read: "failed", overlap: true, observeEffective: false },
  { read: "deferred", overlap: true, observeEffective: true },
  { read: "fresh", overlap: true, observeEffective: false },
] as const)(
  "settles only admitted effective speed ($read read, overlap=$overlap, event=$observeEffective)",
  async ({ read, overlap, observeEffective }) => {
    const initial = settingsRow("settings-ownership", {
      label: "Original label",
      fastMode: false,
      effectiveFastMode: false,
      contextWindow: "64k",
    });
    const firstReply = createDeferred<unknown>();
    const secondReply = createDeferred<unknown>();
    let calls = 0;
    let acknowledged = false;
    let postAckReads = 0;
    let committed = initial;
    const patch = vi.fn<GatewayRequestHandler>(() => {
      calls += 1;
      if (calls === 1) {
        return firstReply.promise;
      }
      expect(calls).toBe(2);
      return secondReply.promise;
    });
    const fixture = createMountedPanes([initial], "main", undefined, {
      "sessions.patch": patch,
      "sessions.list": () => {
        if (!acknowledged) {
          return sessionsResult([initial], 1);
        }
        postAckReads += 1;
        if (read === "failed") {
          throw new Error("Synthetic unavailable effective-speed readback");
        }
        return sessionsResult(
          read === "fresh"
            ? [{ ...committed, updatedAt: (committed.updatedAt ?? 0) + 1, effectiveFastMode: true }]
            : [initial],
          (committed.updatedAt ?? 0) + 1,
        );
      },
    });
    const { sessions, emitGatewayEvent } = fixture;
    let first: ReturnType<typeof sessions.patch> | undefined;
    let second: ReturnType<typeof sessions.patch> | undefined;
    try {
      const { assertRows } = await mountSettings(fixture, initial);
      const assertModes = (
        fastMode: GatewaySessionRow["fastMode"],
        effectiveFastMode: GatewaySessionRow["effectiveFastMode"],
      ) => {
        assertRows({ sessionId: initial.sessionId, fastMode, effectiveFastMode });
      };
      const options = { agentId: "main", deferListRefresh: read === "deferred" };
      first = sessions.patch(initial.key, { fastMode: true }, options);
      assertModes(true, true);
      await withSessionMutationOperations(() => undefined);
      expect(patch).toHaveBeenCalledOnce();
      if (observeEffective) {
        emitGatewayEvent("sessions.changed", {
          sessionKey: initial.key,
          agentId: "main",
          sessionId: initial.sessionId,
          reason: "patch",
          session: { ...initial, updatedAt: 2, fastMode: true, effectiveFastMode: true },
        });
        expect(sessions.state.result?.sessions[0]?.updatedAt).toBe(2);
      }
      if (overlap) {
        second = sessions.patch(initial.key, { fastMode: "auto" }, options);
        expect(patch).toHaveBeenCalledTimes(2);
        assertModes("auto", "auto");
      }

      committed = { ...initial, updatedAt: 3, fastMode: true };
      acknowledged = true;
      firstReply.resolve(settingsAck(initial, { updatedAt: 3, fastMode: true }));
      await expect(first).resolves.toMatchObject({ entry: { fastMode: true } });
      if (overlap) {
        assertModes("auto", "auto");
        committed = { ...initial, updatedAt: 5, fastMode: "auto" };
        secondReply.resolve(settingsAck(initial, { updatedAt: 5, fastMode: "auto" }));
        await expect(second).resolves.toMatchObject({ entry: { fastMode: "auto" } });
      }
      if (read === "deferred") {
        expect(postAckReads).toBe(0);
      } else {
        expect(postAckReads).toBeGreaterThan(0);
      }
      assertModes(overlap ? "auto" : true, observeEffective || read === "fresh");
    } finally {
      firstReply.resolve(settingsAck(initial, { updatedAt: 3, fastMode: true }));
      secondReply.resolve(settingsAck(initial, { updatedAt: 5, fastMode: "auto" }));
      await Promise.allSettled([first, second]);
      await vi.dynamicImportSettled();
    }
  },
);
