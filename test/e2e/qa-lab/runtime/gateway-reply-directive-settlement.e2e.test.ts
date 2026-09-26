import { asOptionalRecord } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  AUTHORED_REPLY_ID,
  SPOKEN_TEXT,
  TERMINAL_TEXT,
  withReplySettlementGateway,
} from "./gateway-reply-directive-settlement.fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const deliveryFacts = (events: unknown[]) =>
  events.flatMap((event) => {
    const facts = asOptionalRecord(asOptionalRecord(event)?.message)?.openclawDelivery;
    return facts ? [facts] : [];
  });

describe("Gateway reply directives across pending physical delivery", () => {
  it.each([
    { oracle: "media", delayed: false },
    { oracle: "media", delayed: true },
    { oracle: "speech", delayed: true },
  ] as const)(
    "preserves the $oracle contract with delayed prelude acknowledgement=$delayed",
    { timeout: 90_000 },
    async ({ oracle, delayed }) => {
      const tempHome = tempDirs.make("openclaw-gateway-reply-settlement-");
      await withReplySettlementGateway(tempHome, oracle, async (fixture) => {
        expect((await fixture.trace()).sdkPaths).toEqual(fixture.expectedSdkPaths);
        const run = fixture.start();
        await expect
          .poll(
            async () =>
              (await fixture.trace()).events.some(
                (event) =>
                  event.stage === "entered" &&
                  event.media.some((media) => media.sha256 === fixture.preludeSha256),
              ),
            { timeout: 15_000, interval: 50 },
          )
          .toBe(true);
        if (!delayed) {
          await fixture.releasePrelude();
          await expect
            .poll(
              async () =>
                (await fixture.trace()).events.some(
                  (event) =>
                    event.stage === "accepted" &&
                    event.media.some((media) => media.sha256 === fixture.preludeSha256),
                ),
              { timeout: 15_000, interval: 50 },
            )
            .toBe(true);
        }
        const beforeFinalResponse = await fixture.trace();
        fixture.allowFinalResponse();
        const sessionKey = (await fixture.trace()).sessionKey;
        expect(sessionKey).toBeDefined();
        if (!sessionKey) {
          throw new Error("Ingress did not publish a session key");
        }
        const expectedFacts =
          oracle === "speech"
            ? { tts: { tagged: true, text: SPOKEN_TEXT } }
            : { replyToId: AUTHORED_REPLY_ID, audioAsVoice: true };
        if (delayed) {
          await expect
            .poll(() => fixture.transcript(sessionKey), { timeout: 15_000, interval: 50 })
            .toContainEqual(
              expect.objectContaining({
                type: "message",
                message: expect.objectContaining({
                  role: "assistant",
                  openclawDelivery: expect.objectContaining(expectedFacts),
                }),
              }),
            );
          const pending = await fixture.trace();
          expect(pending.settled).toBe(false);
          expect(pending.events.filter((event) => event.stage === "accepted")).toEqual([]);
          expect(
            pending.events.some((event) =>
              event.media.some((media) => media.sha256 === fixture.audioSha256),
            ),
          ).toBe(false);
          expect(fixture.providerToolResults()).toEqual([
            { callId: "call_prepare", output: "Report ready." },
          ]);
          const persistedWhileHeld = deliveryFacts(await fixture.transcript(sessionKey));
          console.info(
            "Gateway held-prelude proof",
            JSON.stringify({ oracle, persistedWhileHeld, pending }),
          );
          await fixture.releasePrelude();
        }
        await run;
        const persistedFacts = deliveryFacts(await fixture.transcript(sessionKey));
        const final = await fixture.trace();
        console.info(
          "Gateway settlement proof",
          JSON.stringify({ oracle, delayed, beforeFinalResponse, persistedFacts, final }),
        );
        expect(final.settled).toBe(true);
        expect(fixture.providerToolResults()).toEqual([
          { callId: "call_prepare", output: "Report ready." },
        ]);
        const entered = final.events.filter((event) => event.stage === "entered");
        const accepted = final.events.filter((event) => event.stage === "accepted");
        expect(accepted.map((event) => event.sequence)).toEqual(
          entered.map((event) => event.sequence),
        );
        expect(
          entered.filter((event) =>
            event.media.some((media) => media.sha256 === fixture.preludeSha256),
          ),
        ).toHaveLength(1);
        const finals = entered.filter((event) =>
          event.media.some((media) => media.sha256 === fixture.audioSha256),
        );
        expect(finals).toHaveLength(1);
        const firstFinal = finals[0];
        expect(firstFinal?.media).toEqual([
          expect.objectContaining({ bytes: expect.any(Number), sha256: fixture.audioSha256 }),
        ]);
        expect(firstFinal?.media[0]?.bytes).toBeGreaterThan(0);
        if (oracle === "speech") {
          expect(final.synthesis).toEqual([{ text: SPOKEN_TEXT, target: "audio-file" }]);
          expect(firstFinal?.payload.spokenText).toBe(SPOKEN_TEXT);
          expect(firstFinal?.payload.text).toBeUndefined();
        } else {
          expect(final.synthesis).toEqual([]);
          expect(firstFinal?.payload).toMatchObject({
            replyToId: AUTHORED_REPLY_ID,
            audioAsVoice: true,
          });
          expect(firstFinal?.payload.replyToId).not.toBe("current-inbound");
        }
      });
    },
  );

  it(
    "preserves the authored target on the first terminal text send",
    { timeout: 90_000 },
    async () => {
      const tempHome = tempDirs.make("openclaw-gateway-terminal-text-");
      await withReplySettlementGateway(tempHome, "text", async (fixture) => {
        expect((await fixture.trace()).sdkPaths).toEqual(fixture.expectedSdkPaths);
        const run = fixture.start();
        fixture.allowFinalResponse();
        await expect
          .poll(
            async () => {
              const sessionKey = (await fixture.trace()).sessionKey;
              return sessionKey ? fixture.transcript(sessionKey) : [];
            },
            { timeout: 15_000, interval: 50 },
          )
          .toContainEqual(
            expect.objectContaining({
              type: "message",
              message: expect.objectContaining({
                role: "assistant",
                openclawDelivery: expect.objectContaining({ replyToId: AUTHORED_REPLY_ID }),
              }),
            }),
          );
        await run;
        const final = await fixture.trace();
        const sessionKey = final.sessionKey;
        expect(sessionKey).toBeDefined();
        if (!sessionKey) {
          throw new Error("Ingress did not publish a session key");
        }
        const persistedFacts = deliveryFacts(await fixture.transcript(sessionKey));
        console.info("Gateway terminal-text proof", JSON.stringify({ persistedFacts, final }));
        expect(final.settled).toBe(true);
        expect(fixture.providerToolResults()).toEqual([]);
        expect(final.synthesis).toEqual([]);
        const entered = final.events.filter((event) => event.stage === "entered");
        const accepted = final.events.filter((event) => event.stage === "accepted");
        expect(entered).toHaveLength(1);
        expect(accepted).toHaveLength(1);
        expect(accepted[0]?.sequence).toBe(entered[0]?.sequence);
        const firstFinal = entered[0];
        expect(firstFinal?.media).toEqual([]);
        expect(firstFinal?.payload.text).toBe(TERMINAL_TEXT);
        expect(firstFinal?.payload.replyToId).toBe(AUTHORED_REPLY_ID);
        expect(firstFinal?.payload.replyToId).not.toBe("current-inbound");
      });
    },
  );
});
