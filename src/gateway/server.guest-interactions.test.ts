import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { SessionReactionsListResult } from "../../packages/gateway-protocol/src/schema/sessions-reactions.js";
import type {
  SessionSuggestionsListResult,
  SessionTypingResult,
} from "../../packages/gateway-protocol/src/schema/sessions-suggestions.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as sessions from "../config/sessions.js";
import * as suggestionWrites from "../config/sessions/session-metadata-write.async.js";
import * as reactionWrites from "../config/sessions/session-reaction-store.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import * as typingState from "./server-methods/session-typing-state.js";
import * as transcriptReaders from "./session-transcript-readers.js";

it("rechecks invited reactions, suggestions, and queued typing over TLS", async ({ signal }) => {
  await withInvitedGuestGateway(signal, async ({ gateway, sender, invited, carol, events }) => {
    const { key, sessionId } = await sender.request<{ key: string; sessionId: string }>(
      "sessions.create",
      { agentId: "main", visibility: "suggest" },
      { signal },
    );
    const target = { sessionKey: key, agentId: "main" };
    const membership = (action: "add" | "remove") =>
      sender.request(`session.members.${action}`, { ...target, identityId: carol.id }, { signal });
    const { messageId } = await sender.request<{ messageId: string }>(
      "chat.inject",
      { ...target, message: "Synthetic reaction target" },
      { signal },
    );
    const reactions = () =>
      invited.request<SessionReactionsListResult>("session.reactions.list", target, { signal });
    const react = (emoji: string) =>
      invited.request("session.reactions.set", { ...target, messageId, emoji }, { signal });
    const suggestions = () =>
      invited.request<SessionSuggestionsListResult>("session.suggestions.list", target, { signal });
    const suggest = (text: string) =>
      invited.request("session.suggestions.add", { ...target, text }, { signal });
    const type = (preview: string) =>
      invited.request<SessionTypingResult>(
        "session.typing",
        { ...target, sessionId, typing: true, preview },
        { signal },
      );

    for (const request of [
      reactions,
      () => react("👍"),
      suggestions,
      () => suggest("Not a member"),
      () => type("Not a member"),
    ]) {
      await expect(request()).rejects.toThrow();
    }
    await membership("add");
    for (const client of [sender, invited]) {
      await client.request("sessions.messages.subscribe", { key, agentId: "main" }, { signal });
    }
    expect(await react("👍")).toMatchObject({
      messageId,
      reactions: [{ emoji: "👍", count: 1 }],
      mirror: { status: "skipped" },
    });
    expect((await reactions()).reactions[messageId]).toMatchObject([{ emoji: "👍", count: 1 }]);
    expect(await suggest("Allowed suggestion")).toMatchObject({
      suggestion: { text: "Allowed suggestion", state: "pending" },
    });
    expect((await suggestions()).suggestions.map(({ text }) => text)).toEqual([
      "Allowed suggestion",
    ]);
    for (const eventName of ["session.reaction", "session.suggestion"]) {
      await expect
        .poll(() => events.invited.filter(({ event }) => event === eventName).length)
        .toBe(1);
    }
    const boundaries = [
      {
        name: "reaction response",
        request: reactions,
        install: (pause: () => Promise<void>) => {
          const read = transcriptReaders.readSessionReactionsAsync;
          return vi
            .spyOn(transcriptReaders, "readSessionReactionsAsync")
            .mockImplementationOnce(async (...args) => {
              const result = await read(...args);
              await pause();
              return result;
            });
        },
      },
      {
        name: "reaction write admission",
        request: () => react("🎉"),
        install: (pause: () => Promise<void>) => {
          const write = reactionWrites.setSessionReactionAsync;
          return vi
            .spyOn(reactionWrites, "setSessionReactionAsync")
            .mockImplementationOnce(async (...args) => {
              await pause();
              return write(...args);
            });
        },
      },
      {
        name: "suggestion response",
        request: suggestions,
        install: (pause: () => Promise<void>) => {
          const read = sessions.listSessionSuggestions;
          return vi
            .spyOn(sessions, "listSessionSuggestions")
            .mockImplementationOnce(async (...args) => {
              const result = await read(...args);
              await pause();
              return result;
            });
        },
      },
      {
        name: "suggestion pre-dispatch admission",
        request: () => suggest("Revoked suggestion"),
        install: (pause: () => Promise<void>) => {
          const write = suggestionWrites.addSessionSuggestionInWorker;
          return vi
            .spyOn(suggestionWrites, "addSessionSuggestionInWorker")
            .mockImplementationOnce(async (...args) => {
              await pause();
              return write(...args);
            });
        },
      },
    ];
    for (const boundary of boundaries) {
      const entered = createDeferred();
      const released = createDeferred();
      using _ = boundary.install(async () => {
        entered.resolve();
        await withinTest(released.promise, signal);
      });
      const pending = boundary.request();
      void pending.catch(() => {});
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, pending, `${boundary.name} was not reached`),
          signal,
        );
        await membership("remove");
        released.resolve();
        await expect(pending).rejects.toThrow();
      } finally {
        released.resolve();
        await Promise.allSettled([pending]);
      }
      await membership("add");
    }
    // Real readers prove rejected writes left no committed collaboration state.
    expect((await reactions()).reactions[messageId]).toMatchObject([{ emoji: "👍", count: 1 }]);
    expect((await reactions()).reactions[messageId]).toHaveLength(1);
    expect((await suggestions()).suggestions.map(({ text }) => text)).toEqual([
      "Allowed suggestion",
    ]);
    for (const client of [sender, invited]) {
      await client.request(
        "sessions.viewers.set",
        { sessionKeys: [key], agentId: "main" },
        { signal },
      );
    }
    const watchers = typingState.liveViewerIdentities(new Set([key]));
    expect(watchers.size).toBe(2);
    const timerEntered = createDeferred();
    const schedule = globalThis.setTimeout;
    const throttle = typingState.broadcastTypingThrottled;
    const emissions: boolean[] = [];
    let clock = Date.now();
    let insideThrottle = false;
    let scheduled = 0;
    let releaseTimer: (() => void) | undefined;
    // Hold only the throttle's native timer; other Gateway timers stay real.
    using cleanup = new DisposableStack();
    cleanup.use(
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, milliseconds, ...args) => {
        if (!insideThrottle) {
          return schedule(callback, milliseconds, ...args);
        }
        scheduled += 1;
        return schedule(() => {
          releaseTimer = () => callback(...args);
          timerEntered.resolve();
        }, milliseconds);
      }),
    );
    cleanup.use(
      vi.spyOn(typingState, "broadcastTypingThrottled").mockImplementation((params) => {
        insideThrottle = true;
        try {
          return throttle({
            ...params,
            // The existing clock input guarantees the second RPC queues.
            now: clock++,
            emit: () => {
              const emitted = params.emit();
              emissions.push(emitted);
              return emitted;
            },
          });
        } finally {
          insideThrottle = false;
        }
      }),
    );
    try {
      expect(await type("Allowed preview")).toEqual({ ok: true, broadcast: true });
      await expect
        .poll(() =>
          events.sender.some(
            ({ event, payload }) =>
              event === "session.typing" &&
              isRecord(payload) &&
              payload.sessionKey === key &&
              payload.preview === "Allowed preview",
          ),
        )
        .toBe(true);
      expect(await type("Revoked queued preview")).toEqual({ ok: true, broadcast: false });
      expect(scheduled).toBe(1);
      await withinTest(timerEntered.promise, signal);
      expect(emissions).toEqual([true]);
      await membership("remove");
      expect(typingState.liveViewerIdentities(new Set([key]))).toEqual(watchers);
      if (!releaseTimer) {
        throw new Error("Queued typing timer was not retained");
      }
      releaseTimer();
      releaseTimer = undefined;
      expect(emissions).toEqual([true, false]);
      // Same-socket responses fence preceding event writes.
      await sender.request("sessions.list", { agentId: "main" }, { signal });
      await gateway.client.request("sessions.list", { agentId: "main" }, { signal });
      expect(
        events.sender.some(
          ({ event, payload }) =>
            event === "session.typing" &&
            isRecord(payload) &&
            payload.preview === "Revoked queued preview",
        ),
      ).toBe(false);
      expect(events.sender.filter(({ event }) => event === "session.reaction")).toHaveLength(1);
      expect(events.sender.filter(({ event }) => event === "session.suggestion")).toHaveLength(1);
      expect(
        events.guest.some(({ event }) =>
          ["session.reaction", "session.suggestion", "session.typing"].includes(event ?? ""),
        ),
      ).toBe(false);
      await expect(type("After removal")).rejects.toThrow();
    } finally {
      typingState.clearSessionTypingState();
    }
  });
});
