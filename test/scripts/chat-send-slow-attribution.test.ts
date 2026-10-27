import { expect, it } from "vitest";
import { attributeSlowChatSend } from "../../scripts/perf/chat-send-slow-attribution.js";

it("ranks inclusive spans by stage, separates FIFO waits, and ignores private or malformed records", async () => {
  async function* lines() {
    yield* [
      "2026-10-27T12:00:00Z [gateway] slow chat send 1200ms stage=request ack=25ms preparation=1100ms detail.persist.stage=800ms detail.persist.stage.write=500ms",
      JSON.stringify({
        message:
          "slow chat send 1500ms stage=request detail.persist.stage=400ms detail.persist.stage.write=600ms",
        sessionKey: "private-session",
      }),
      JSON.stringify({
        "0": '{"subsystem":"gateway"}',
        "1": "slow chat send 9000ms stage=startup ack=25ms detail.reply.admit_dispatch=8000ms detail.reply.init_session_state=1000ms",
      }),
      "slow chat send 2000ms stage=steer detail.run_admission.steer_prepare=1200ms detail.persist.stage=200ms",
      "slow chat send 3000ms stage=queued detail.reply.admit_dispatch=2900ms",
      "slow chat send 1200ms stage=startup detail.reply.admit_dispatch=1000ms detail.reply.init_session_state=200ms",
    ];
    yield "unrelated private-content";
    yield '{"message":"private-content"';
    yield '{"message":"slow chat send 1000ms stage=private-stage"}';
    yield "slow chat send 1000ms stage=request detail.invalid=-1ms detail.invalid2=NaNms detail.invalid3=2msec sessionKey=private-session message=private-content detail.persist.stage=0ms";
    yield "\u001b[32mslow chat send 1000ms stage=request detail.persist.stage=1.5ms\u001b[0m";
  }
  const report = await attributeSlowChatSend(lines());
  expect(report).toMatchObject({ observedLines: 8, ignoredLines: 3 });
  expect(
    report.stages.flatMap(({ stage, reports, details, excludedFifo }) =>
      [...details, excludedFifo].map(({ span, sumMs, count, maxMs }, index) => [
        stage,
        reports,
        index === details.length ? "FIFO" : "ranked",
        span,
        sumMs,
        count,
        maxMs,
      ]),
    ),
  ).toEqual([
    ["request", 4, "ranked", "detail.persist.stage", 1201.5, 4, 800],
    ["request", 4, "ranked", "detail.persist.stage.write", 1100, 2, 600],
    ["request", 4, "FIFO", "detail.reply.admit_dispatch", 0, 0, 0],
    ["startup", 2, "ranked", "detail.reply.init_session_state", 1200, 2, 1000],
    ["startup", 2, "FIFO", "detail.reply.admit_dispatch", 9000, 2, 8000],
    ["steer", 1, "ranked", "detail.run_admission.steer_prepare", 1200, 1, 1200],
    ["steer", 1, "ranked", "detail.persist.stage", 200, 1, 200],
    ["steer", 1, "FIFO", "detail.reply.admit_dispatch", 0, 0, 0],
    ["queued", 1, "FIFO", "detail.reply.admit_dispatch", 2900, 1, 2900],
  ]);
  expect(report.limitations).toContain("Inclusive spans overlap");
  expect(JSON.stringify(report)).not.toContain("private");
});
