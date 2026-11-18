import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { DecisionOutcome } from "../../decisions/host-outcomes.js";
import type { ReplyPayload } from "../types.js";
import { judgment } from "./group-participation.decision.test-support.js";
import { createGroupReplyFixture } from "./group-participation.reply.test-support.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";

const decision = vi.hoisted(() =>
  vi.fn<typeof import("../../decisions/runtime.js").evaluateDecision>(),
);
vi.mock("../../decisions/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../decisions/runtime.js")>()),
  evaluateDecision: decision,
}));

const answer = (content: string) => ({ delta: { role: "assistant", content } });
const unavailable: DecisionOutcome = { status: "unavailable", reason: "overloaded" };
function texts(reply: ReplyPayload | ReplyPayload[] | undefined) {
  return (Array.isArray(reply) ? reply : reply ? [reply] : []).flatMap((payload) =>
    payload.text ? [payload.text] : [],
  );
}
let fixture: Awaited<ReturnType<typeof createGroupReplyFixture>>;
beforeAll(async () => {
  fixture = await createGroupReplyFixture();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(() => {
  decision.mockReset();
});

it("runs an opportunity through ordinary tools, streaming and delivery without draft review", async () => {
  const previousTyping = fixture.typing();
  const previousPartials = fixture.partials.length;
  const previousRequests = fixture.requests.length;
  const previousSent = fixture.sent.length;
  fixture.respond(
    {
      delta: {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "read-port",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: fixture.lookupPath }) },
          },
        ],
      },
      stop: "tool_calls",
    },
    answer("The published TLS port is 443."),
  );
  decision.mockImplementation(async (batch) => judgment(batch, { attention: "opportunity" }));
  const delivered = await fixture.dispatch(
    "Bob, do you know the published TLS port?",
    "opportunity-source",
    "-10002",
  );
  expect(delivered.queuedFinal).toBe(true);
  expect(fixture.sent.slice(previousSent)).toEqual(["The published TLS port is 443."]);
  expect(decision).toHaveBeenCalledTimes(1);
  expect(decision.mock.calls[0]?.[1].purpose).toBe("group.participation.attention");
  expect(fixture.requests).toHaveLength(previousRequests + 2);
  expect(fixture.requests[previousRequests]).toMatchObject({
    tools: expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: "exec" }) }),
    ]),
  });
  expect(fixture.typing()).toBeGreaterThan(previousTyping);
  expect(fixture.partials.slice(previousPartials).join("")).toContain(
    "The published TLS port is 443.",
  );
});

it("uses ordinary streaming and tools when the preflight decision is unavailable", async () => {
  const previousRequests = fixture.requests.length;
  const runState: ReplyOperationRunState = {};
  const previousPartials = fixture.partials.length;
  fixture.respond(answer("Ordinary answer after the outage."));
  decision.mockResolvedValue(unavailable);
  expect(
    texts(
      await fixture.reply("Bob, which port should I use?", "outage-source", "-10004", {
        [REPLY_OPERATION_RUN_STATE]: runState,
      }),
    ),
  ).toContain("Ordinary answer after the outage.");
  expect(runState.replyCompletion?.expectation).toBe("required");
  expect(decision).toHaveBeenCalledTimes(1);
  expect(fixture.requests).toHaveLength(previousRequests + 1);
  expect(fixture.requests[previousRequests]).toMatchObject({
    tools: expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: "exec" }) }),
    ]),
  });
  expect(fixture.partials.slice(previousPartials).join("")).toContain(
    "Ordinary answer after the outage.",
  );
});
